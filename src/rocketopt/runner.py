"""Turns a :class:`~rocketopt.spec.RunSpec` into results the app can draw.

Nothing is reported that was not simulated: every design that reaches the user
has been re-run at the verification timestep with all margins removed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from dataclasses import fields as dataclass_fields
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

from .design import DesignSpace, SpaceConfig
from .optimize import (Objective, direct_pareto, direct_search, pareto_indices,
                       scale_constraints, surrogate_candidates)
from .sampling import SimulationPool, evaluate_batch, mixed_designs
from .simulate import PA_PER_PSI, Metrics, curves, simulate_motor
from .ric import clone
from .spec import (MAX_DESIGNS, OPTIMISABLE_METRICS, SURROGATE_GEN,
                   SURROGATE_POP, RunSpec, VariableSpec, core_specs)
from .surrogate import Surrogate, needed_targets
from .units import KG_M2S_PER_LB_IN2S, M_PER_IN

ProgressFn = Callable[[str, float, str], None]
#: Called once per generation with a snapshot of the live population.
TelemetryFn = Callable[[Dict], None]

#: Points sent per generation. More than a scatter shows usefully.
TELEMETRY_POINTS = 160

#: Second axis for a single-objective live view. Framing only; never searched.
COMPANION_METRICS = ("total_impulse", "initial_thrust", "isp", "burn_time",
                     "max_pressure")

#: Extra tightening on top of the measured timestep correction, which was
#: calibrated on one motor.
SEARCH_SAFETY_MARGIN = 0.005


def _noop(stage: str, fraction: float, message: str) -> None:
    pass


def _noop_telemetry(snapshot: Dict) -> None:
    pass


def _snapshot(frame: pd.DataFrame, objective: Objective, space: DesignSpace,
              metrics: List[str], generation: int, seed_index: int,
              n_seeds: int, surrogate: bool = False) -> Optional[Dict]:
    """One generation of the search, in the units the axes are labelled in."""
    if frame is None or not len(frame) or not metrics:
        return None
    single = len(metrics) < 2
    if single:
        # Borrow a second axis so the population has somewhere to spread.
        companion = next((m for m in COMPANION_METRICS
                          if m != metrics[0] and m in frame.columns), None)
        if companion is None:
            return None
        metrics = [metrics[0], companion]
    scaled = scale_constraints(frame, objective, space)
    violation = scaled.max(axis=1)
    feasible = frame["ok"].to_numpy(dtype=bool) & (violation <= 0)
    x = frame[metrics[1]].to_numpy(dtype=float)
    y = frame[metrics[0]].to_numpy(dtype=float)

    order = np.arange(len(frame))
    if len(order) > TELEMETRY_POINTS:
        # Keep every feasible design; thin the rest.
        keep = np.flatnonzero(feasible)
        rest = np.flatnonzero(~feasible)
        room = max(TELEMETRY_POINTS - len(keep), 0)
        if len(rest) > room:
            rest = rest[np.linspace(0, len(rest) - 1, room).round().astype(int)]
        order = np.concatenate([keep, rest])[:TELEMETRY_POINTS]

    front: List[List[float]] = []
    leader: Optional[Dict] = None
    if feasible.any():
        good = frame[feasible]
        picked = pareto_indices(-objective.matrix(good))
        pts = np.column_stack([good[metrics[1]].to_numpy(dtype=float)[picked],
                               good[metrics[0]].to_numpy(dtype=float)[picked]])
        front = pts[np.argsort(pts[:, 0])].tolist()
        # The legal design scoring highest this generation, with its vector,
        # so a run can hand out its best motor before it finishes. Never on
        # the surrogate path: a prediction is not a motor.
        if not surrogate and all(n in good.columns for n in space.names):
            score = objective.score_frame(good)
            top = good.iloc[int(np.argmax(score))]
            leader = {"x": [float(top[n]) for n in space.names],
                      "score": float(score.max()),
                      "metric": metrics[0], "value": float(top[metrics[0]]),
                      "values": {m: float(top[m]) for m in metrics}}

    return {
        "generation": int(generation),
        "seed_index": int(seed_index),
        "n_seeds": int(n_seeds),
        "metrics": [metrics[1], metrics[0]],
        "points": [[float(x[i]), float(y[i]), bool(feasible[i])] for i in order],
        "front": [[float(a), float(b)] for a, b in front],
        "feasible_fraction": float(feasible.mean()),
        # Which limit is actually stopping designs, so the waiting screen can
        # say what is shaping the search rather than only that it is running.
        "blocking": [
            {"metric": c.metric, "op": c.op,
             "share": float((scaled[:, i] > 0).mean())}
            for i, c in enumerate(objective.constraints)
        ] if objective.constraints else [],
        "single_objective": bool(single),
        "surrogate": bool(surrogate),
        "best": [float(y[feasible].max()), float(x[feasible].max())]
                if feasible.any() else None,
        "leader": leader,
    }


def jsonable(value):
    """numpy and pandas scalars are not JSON; everything here becomes plain."""
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, float) and (np.isnan(value) or np.isinf(value)):
        return None
    return value


# --- Building the space and the objective from a spec ---


def stack_motor(base_motor: Dict, n_grains: int) -> Dict:
    """The loaded stack cut into ``n_grains`` equal grains.

    The total length is held, so every count is the same propellant column
    with more or fewer end faces. openMotor has no inter-grain gap, so the
    length divides exactly.
    """
    grains = base_motor["grains"]
    total = sum(g["properties"]["length"] for g in grains)
    return apply_hardware(base_motor, grain_count=int(n_grains),
                          grain_length=total / int(n_grains))


def grain_counts(spec: RunSpec, base_motor: Dict) -> List[int]:
    """Grain counts this run searches. The file's own count unless freed."""
    return spec.grain_count.counts(len(base_motor["grains"]))


def build_space(spec: RunSpec, base_motor: Dict,
                n_grains: Optional[int] = None) -> DesignSpace:
    """Maps GUI variables onto the internal design space.

    Exit is set as a diameter but stored as a fraction of the span above the
    throat, which keeps exit > throat without a coupled constraint.

    ``n_grains`` restates the stack at another count. A free count restates
    it even at the loaded one, so every count is the same equal slicing.
    """
    by_name = {v.name: v for v in spec.variables}
    loaded = len(base_motor["grains"])
    n_grains = int(n_grains or loaded)
    if spec.grain_count.free or n_grains != loaded:
        base_motor = stack_motor(base_motor, n_grains)
    cores = core_specs(spec, n_grains)
    throat = by_name["throat"]
    exit_var = by_name.get("exit")
    tl = by_name.get("throat_length")

    exit_min = exit_var.low if exit_var else 0.0
    exit_max = exit_var.high if exit_var else 0.095
    exit_step = exit_var.step if exit_var else 0.0
    exit_fixed = None
    if exit_var is not None and not exit_var.free:
        exit_fixed = (exit_var.fixed_value if exit_var.fixed_value is not None
                      else 0.5 * (exit_var.low + exit_var.high))

    config = SpaceConfig(
        core_min=min(c.low for c in cores),
        core_max=max(c.high for c in cores),
        throat_min=throat.low,
        throat_max=throat.high,
        exit_min=exit_min,
        exit_max=exit_max,
        exit_step=exit_step,
        exit_fixed=exit_fixed,
        core_step=cores[0].step,
        throat_step=throat.step,
        include_throat_length=tl is not None,
        throat_length_min=tl.low if tl else 0.0,
        throat_length_max=tl.high if tl else 0.0,
        throat_length_step=tl.step if tl else 0.0,
    )
    internal = list(cores) + [throat, VariableSpec(
        name="exit_frac", free=exit_fixed is None, low=0.0, high=1.0,
        step=exit_step, fixed_value=None if exit_fixed is None else 0.5,
        unit="m", label="Nozzle exit")]
    if tl is not None:
        internal.append(tl)
    return DesignSpace(base_motor, config, variables=internal,
                       ordering=spec.ordering)


def design_space(spec: RunSpec, base_motor: Dict, design: Dict) -> DesignSpace:
    """The space one reported design lives in, whatever its grain count."""
    return build_space(spec, base_motor, design.get("n_grains"))


def motor_for(design: Dict, space: DesignSpace) -> Dict:
    """The openMotor dict behind a reported design.

    Every described design carries its motor, since a run may report designs
    with different grain counts and one space cannot rebuild them all.
    """
    if design.get("motor"):
        return clone(design["motor"])
    return space.to_motor(np.asarray(design["x"], dtype=float))


def apply_hardware(base_motor: Dict, grain_diameter: Optional[float] = None,
                   grain_length: Optional[float] = None,
                   grain_count: Optional[int] = None,
                   inhibited_ends: Optional[str] = None) -> Dict:
    """Restates the case hardware on a motor: grain OD, length, count, ends.

    Narrowing the grain can strand a core outside it, so cores are pulled back
    to leave a minimum web.
    """
    from .ric import clone as _clone

    motor = _clone(base_motor)
    grains = motor["grains"]
    if grain_count is not None and grain_count != len(grains):
        template = _clone(grains[0])
        if grain_count < len(grains):
            grains = grains[:grain_count]
        else:
            grains = grains + [_clone(template) for _ in range(grain_count - len(grains))]
        motor["grains"] = grains
    for grain in grains:
        props = grain["properties"]
        if grain_diameter is not None:
            props["diameter"] = float(grain_diameter)
        if grain_length is not None:
            props["length"] = float(grain_length)
        if inhibited_ends is not None:
            props["inhibitedEnds"] = inhibited_ends
        min_web = 0.125 * M_PER_IN
        largest_core = props["diameter"] - 2 * min_web
        if props["coreDiameter"] > largest_core:
            props["coreDiameter"] = max(largest_core, props["diameter"] * 0.2)
    return motor


def default_spec(base_motor: Dict) -> RunSpec:
    """A starting configuration read off the motor itself.

    Bounds bracket the motor as loaded. Limits are the amateur-practice
    numbers rather than the file's own, which are usually the case rating.
    """
    from .spec import (MAX_GRAIN_COUNT, ConstraintSpec, GrainCountSpec,
                       ObjectiveSpec, OrderingSpec)

    grains = base_motor["grains"]
    bore = grains[0]["properties"]["diameter"]
    cores = [g["properties"]["coreDiameter"] for g in grains]
    throat = base_motor["nozzle"]["throat"]
    exit_d = base_motor["nozzle"]["exit"]

    # A twentieth of an inch. Finer is not held on a mandrel or reamer, and a
    # coarser grid is a far smaller space to search.
    grid = 0.05 * M_PER_IN
    min_web = 0.25 * M_PER_IN
    throat_length = base_motor["nozzle"].get("throatLength", 0.2 * M_PER_IN)

    variables = [
        VariableSpec(name="core_{}".format(i + 1), free=True,
                     low=0.5 * M_PER_IN, high=bore - 2 * min_web,
                     step=grid, fixed_value=core, unit="m",
                     label="Grain {} core".format(i + 1))
        for i, core in enumerate(cores)
    ]
    # Bounds follow the case, not the nozzle currently fitted to it.
    variables.append(VariableSpec(
        name="throat", free=True, low=min(throat * 0.5, bore * 0.10),
        high=bore * 0.60, step=grid, fixed_value=throat, unit="m",
        label="Nozzle throat"))
    variables.append(VariableSpec(
        name="exit", free=True, low=throat * 1.15, high=bore * 1.05,
        step=grid, fixed_value=exit_d, unit="m", label="Nozzle exit"))
    variables.append(VariableSpec(
        name="throat_length", free=True, low=0.05 * M_PER_IN, high=1.0 * M_PER_IN,
        step=grid, fixed_value=throat_length, unit="m", label="Throat length"))

    constraints = [
        ConstraintSpec(metric="max_pressure", op="<=", value=500 * PA_PER_PSI,
                       label="Peak chamber pressure"),
        ConstraintSpec(metric="peak_kn", op="<=", value=225.0,
                       label="Peak Kn"),
        ConstraintSpec(metric="peak_mass_flux", op="<=", value=1.05 * KG_M2S_PER_LB_IN2S,
                       label="Peak mass flux"),
        ConstraintSpec(metric="port_throat", op=">=", value=1.4,
                       label="Port/throat ratio"),
        # Subsonic core flow. openMotor only warns, so the search holds it.
        ConstraintSpec(metric="peak_mach", op="<=", value=1.0,
                       label="Peak core Mach"),
        ConstraintSpec(metric="residual_pct", op="<=", value=5.0, enabled=False,
                       label="Residual propellant"),
        ConstraintSpec(metric="avg_pressure", op=">=", value=200 * PA_PER_PSI,
                       enabled=False, label="Mean chamber pressure"),
        ConstraintSpec(metric="total_impulse", op=">=", value=0.0, enabled=False,
                       label="Total impulse"),
    ]
    return RunSpec(
        variables=variables,
        objectives=[
            ObjectiveSpec(metric="initial_thrust", direction="max", weight=1.0),
            ObjectiveSpec(metric="total_impulse", direction="max", weight=1.0),
        ],
        constraints=constraints,
        ordering=OrderingSpec(mode="nondecreasing"),
        # Off by default; the range brackets the file's count when turned on.
        grain_count=GrainCountSpec(
            free=False, n_min=max(1, len(grains) - 2),
            n_max=min(MAX_GRAIN_COUNT, len(grains) + 2)),
    )


def timestep_bias(base_motor: Dict, search_dt: float, verify_dt: float,
                  metrics=OPTIMISABLE_METRICS) -> Dict[str, float]:
    """How much each metric shifts between search fidelity and verification.

    Measured on the loaded motor rather than guessed, so a design sitting on a
    limit during the search still satisfies it after verification.
    """
    coarse = simulate_motor(base_motor, timestep=search_dt)
    fine = simulate_motor(base_motor, timestep=verify_dt)
    bias: Dict[str, float] = {}
    for name in metrics:
        c = float(getattr(coarse, name, 0.0) or 0.0)
        f = float(getattr(fine, name, 0.0) or 0.0)
        bias[name] = c / f if abs(f) > 1e-12 and abs(c) > 1e-12 else 1.0
    return bias


def build_objective(spec: RunSpec, baseline_metrics,
                    bias: Optional[Dict[str, float]] = None) -> Objective:
    """Objective and constraints as configured.

    Baselines normalise objectives in unrelated units against each other.
    ``bias`` restates the limits at search fidelity.
    """
    baselines = {name: float(getattr(baseline_metrics, name, 0.0) or 0.0)
                 for name in OPTIMISABLE_METRICS}
    bias = bias or {}
    constraints = []
    for spec_c in spec.enabled_constraints:
        data = spec_c.to_dict()
        ratio = bias.get(spec_c.metric, 1.0)
        if ratio and abs(ratio - 1.0) < 0.25:  # ignore anything implausible
            data["value"] = float(spec_c.value) * ratio
        # Extra room on top of the measured shift.
        data["margin"] = spec_c.margin or SEARCH_SAFETY_MARGIN
        constraints.append(type(spec_c)(**data))
    return Objective(
        objectives=tuple(spec.enabled_objectives),
        constraints=tuple(constraints),
        baselines=baselines,
    )


# --- Results ---


@dataclass
class RunResult:
    baseline: Dict = field(default_factory=dict)
    designs: List[Dict] = field(default_factory=list)
    population: List[Dict] = field(default_factory=list)
    convergence: List[Dict] = field(default_factory=list)
    surrogate: Optional[Dict] = None
    constraint_activity: List[Dict] = field(default_factory=list)
    sensitivity: List[Dict] = field(default_factory=list)
    stats: Dict = field(default_factory=dict)
    messages: List[str] = field(default_factory=list)
    #: The configuration this run used, so later edits cannot mislabel it.
    spec: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return jsonable({
            "spec": self.spec,
            "baseline": self.baseline,
            "designs": self.designs,
            "population": self.population,
            "convergence": self.convergence,
            "surrogate": self.surrogate,
            "constraint_activity": self.constraint_activity,
            "sensitivity": self.sensitivity,
            "stats": self.stats,
            "messages": self.messages,
        })


def describe_design(space: DesignSpace, x: np.ndarray, spec: RunSpec,
                    label: str, with_curves: bool = False,
                    metrics=None) -> Dict:
    """One design, simulated at the verification timestep.

    ``metrics`` MUST come from that same timestep when supplied; it saves
    re-running a burn the ranking already did.
    """
    x = space.canonical_one(np.asarray(x, dtype=float))
    motor = space.to_motor(x)
    if metrics is None:
        metrics = simulate_motor(motor, timestep=spec.verify_timestep)
    row = metrics.as_row()
    row.update({
        "label": label,
        "x": [float(v) for v in x],
        "cores": [float(g["properties"]["coreDiameter"]) for g in motor["grains"]],
        "grain_diameter": float(space.grain_diameter),
        "grain_lengths": [float(v) for v in space.grain_lengths],
        "n_grains": int(space.n_grains),
        "motor": motor,
        "throat": float(motor["nozzle"]["throat"]),
        "exit": float(motor["nozzle"]["exit"]),
        "expansion_ratio": float((motor["nozzle"]["exit"] / motor["nozzle"]["throat"]) ** 2),
        "throat_length": float(motor["nozzle"].get("throatLength", 0.0)),
        "inhibited_ends": motor["grains"][0]["properties"].get("inhibitedEnds", "Neither"),
        "max_pressure_psi": float(metrics.max_pressure / PA_PER_PSI),
        "avg_pressure_psi": float(metrics.avg_pressure / PA_PER_PSI),
        "mass_flux_lb": float(metrics.peak_mass_flux / KG_M2S_PER_LB_IN2S),
    })
    if with_curves:
        row["curves"] = curves(motor, timestep=spec.verify_timestep)
    return row


def _constraint_report(frame: pd.DataFrame, objective: Objective,
                       space: DesignSpace) -> List[Dict]:
    """Which limits are actually doing the work."""
    active = [c for c in objective.constraints if c.enabled]
    if not active or not len(frame):
        return []
    violations = scale_constraints(frame, objective.strict(), space)
    report = []
    for i, spec_c in enumerate(active):
        column = violations[:, i]
        feasible = column <= 0
        near = feasible & (column > -0.02)
        report.append({
            "metric": spec_c.metric,
            "label": OPTIMISABLE_METRICS.get(spec_c.metric, {}).get(
                "label", spec_c.metric),
            "op": spec_c.op,
            "value": float(spec_c.value),
            "binding_fraction": float(near.sum() / max(feasible.sum(), 1)),
            "violated_fraction": float((~feasible).sum() / max(len(column), 1)),
        })
    return report


def _sensitivity(space: DesignSpace, x: np.ndarray, objective: Objective,
                 spec: RunSpec, workers: Optional[int] = None) -> List[Dict]:
    """How much the leading objective moves if each dimension is nudged.

    One grid step either way where a machining grid is set, otherwise 2% of the
    range, so the result reflects changes that can actually be machined.
    """
    x = space.canonical_one(np.asarray(x, dtype=float))
    metric = objective.objective_labels[0]
    base_row = evaluate_batch(space, x[None, :], timestep=spec.verify_timestep,
                              workers=1)
    if not len(base_row) or not bool(base_row["ok"].iloc[0]):
        return []
    reference = float(base_row[metric].iloc[0])

    probes, meta = [], []
    for slot, index in enumerate(space.free_index):
        var = space.specs[index]
        delta = var.step if var.step and var.step > 0 else 0.02 * (var.high - var.low)
        for sign in (-1.0, 1.0):
            probe = x.copy()
            probe[slot] = np.clip(probe[slot] + sign * delta, var.low, var.high)
            probes.append(probe)
            meta.append((var, sign))
    frame = evaluate_batch(space, np.array(probes), timestep=spec.verify_timestep,
                           workers=workers)

    gathered: Dict[str, Dict] = {}
    for (var, sign), (_, row) in zip(meta, frame.iterrows()):
        entry = gathered.setdefault(var.name, {
            "variable": var.name, "label": var.label or var.name,
            "down": 0.0, "up": 0.0})
        change = (float(row[metric]) - reference) if bool(row["ok"]) else 0.0
        entry["down" if sign < 0 else "up"] = change
    for entry in gathered.values():
        entry["span"] = abs(entry["up"] - entry["down"])
    return sorted(gathered.values(), key=lambda e: -e["span"])


def _convergence(history: pd.DataFrame, objective: Objective,
                 space: DesignSpace, cap: int = 4000) -> List[Dict]:
    if not len(history):
        return []
    violation = scale_constraints(history, objective, space).max(axis=1)
    score = objective.score_frame(history)
    feasible = history["ok"].to_numpy(dtype=bool) & (violation <= 0)
    best = np.maximum.accumulate(np.where(feasible, score, -np.inf))
    stride = max(1, len(best) // cap)
    return [{"n": int(i + 1), "best": float(v)}
            for i, v in enumerate(best) if np.isfinite(v) and i % stride == 0]


def _population(history: pd.DataFrame, objective: Objective, space: DesignSpace,
                names: Optional[List[str]] = None, cap: int = 4000) -> List[Dict]:
    """A sample of everything simulated, for the scatter and parallel plots.

    ``names`` are the dimension columns to carry; the space's own by default.
    A run over several grain counts passes the columns every count shares.
    """
    if not len(history):
        return []
    frame = history.copy()
    violation = scale_constraints(frame, objective.strict(), space).max(axis=1)
    frame["feasible"] = frame["ok"].to_numpy(dtype=bool) & (violation <= 0)
    if len(frame) > cap:
        frame = frame.sample(cap, random_state=0)
    names = list(space.names) if names is None else list(names)
    columns = ([m for m in OPTIMISABLE_METRICS if m in frame.columns]
               + [n for n in names if n in frame.columns] + ["feasible"])
    return frame[columns].to_dict("records")


# --- The run itself ---


@dataclass
class _Stack:
    """One grain count under consideration, with everything its search needs."""

    n: int
    space: DesignSpace
    objective: Objective
    seeds: np.ndarray
    grain_length: float
    screen: Dict = field(default_factory=dict)
    dropped: Optional[str] = None
    stage1: Optional[Dict] = None
    carried: bool = False
    front: pd.DataFrame = field(default_factory=pd.DataFrame)
    #: The front's rows already hold fine-timestep metrics.
    verified: bool = False
    history: pd.DataFrame = field(default_factory=pd.DataFrame)
    designs: List[Dict] = field(default_factory=list)
    per_seed: List[Dict] = field(default_factory=list)
    surrogate: Optional[Dict] = None
    sim_seconds: float = 0.0

    def summary(self) -> Dict:
        stage1 = None
        if self.stage1 is not None:
            stage1 = {k: v for k, v in self.stage1.items() if k != "front"}
        return {"n": self.n, "grain_length": self.grain_length,
                "screen": self.screen, "dropped": self.dropped,
                "stage1": stage1, "carried": self.carried,
                "designs": len(self.designs),
                "simulations": int(len(self.history))}


class _Meter:
    """Simulations done against the plan, so the waiting screen has a bar.

    The plan changes once the first stage has chosen which counts go on, so
    the total is restated then.
    """

    def __init__(self, total: int = 0) -> None:
        self.total = int(total)
        self.done = 0

    def stamp(self, snap: Dict, within: int) -> None:
        snap["simulations_done"] = int(self.done + within)
        snap["simulations_total"] = int(max(self.total, self.done + within))


def _window(lo: float, hi: float, index: int, count: int):
    """The ``index``-th of ``count`` equal slices of a progress window."""
    span = (hi - lo) / max(count, 1)
    return lo + span * index, lo + span * (index + 1)


def _file_space(spec: RunSpec, base_motor: Dict) -> DesignSpace:
    """The motor exactly as its file has it, whatever the count rule says."""
    from dataclasses import replace as _replace
    from .spec import GrainCountSpec

    return build_space(_replace(spec, grain_count=GrainCountSpec()), base_motor)


def run(spec: RunSpec, base_motor: Dict, on_progress: ProgressFn = _noop,
        workers: Optional[int] = None,
        on_telemetry: TelemetryFn = _noop_telemetry) -> RunResult:
    problems = spec.validate()
    if problems:
        raise ValueError("; ".join(problems))

    started = time.time()
    result = RunResult(spec=spec.to_dict())
    on_progress("baseline", 0.02, "Simulating your current motor")

    baseline_metrics = simulate_motor(base_motor, timestep=spec.verify_timestep)
    # Verification uses the limits exactly as the user typed them.
    verify_objective = build_objective(spec, baseline_metrics, bias=None).strict()
    budget = spec.budget
    n_obj = len(spec.enabled_objectives)

    base_space = _file_space(spec, base_motor)
    baseline_x = base_space.from_motor(base_motor)
    result.baseline = describe_design(base_space, baseline_x, spec, "Your motor",
                                      with_curves=True)
    # Report the motor as it is, not as the grid rounds it.
    result.baseline.update({
        "cores": [float(g["properties"]["coreDiameter"]) for g in base_motor["grains"]],
        "throat": float(base_motor["nozzle"]["throat"]),
        "exit": float(base_motor["nozzle"]["exit"]),
        **{k: float(getattr(baseline_metrics, k)) for k in
           ("initial_thrust", "total_impulse", "isp", "burn_time", "peak_kn",
            "initial_kn", "port_throat", "prop_mass", "peak_mass_flux")},
        "max_pressure_psi": float(baseline_metrics.max_pressure / PA_PER_PSI),
        "mass_flux_lb": float(baseline_metrics.peak_mass_flux / KG_M2S_PER_LB_IN2S),
    })

    stacks = _build_stacks(spec, base_motor, baseline_metrics)
    several = len(stacks) > 1
    per_count = budget["samples"] if spec.mode == "pareto" else budget["total"]
    meter = _Meter(per_count)

    if several:
        on_progress("screen", 0.04, "Checking which grain counts can be legal")
        for stack in stacks:
            stack.dropped = _screen(stack, spec)
        live = [s for s in stacks if s.dropped is None]
        if not live:
            # Nothing passes on paper. Search every count anyway, so the
            # report can say which limit could not be met.
            for stack in stacks:
                stack.dropped = None
            live = stacks
        stage_sims = budget["pop"] * spec.grain_count.stage_generations
        meter.total = stage_sims * len(live) + per_count * min(
            len(live), spec.grain_count.carry)
        _stage_one(live, spec, budget, n_obj, workers, on_progress,
                   on_telemetry, meter, (0.06, 0.24))
        _select(live, spec)
        carried = [s for s in live if s.carried]
        meter.total = meter.done + per_count * len(carried)
    else:
        stacks[0].carried = True
        carried = stacks

    search_started = time.time()
    lo, hi = (0.26, 0.88) if several else (0.08, 0.88)
    for index, stack in enumerate(carried):
        _search_stack(stack, spec, budget, n_obj, workers, on_progress,
                      on_telemetry, meter, _window(lo, hi, index, len(carried)),
                      several)
    search_seconds = time.time() - search_started

    on_progress("verify", 0.90, "Re-simulating the winners at full fidelity")
    for stack in carried:
        stack.designs = _rank_designs(stack.space, stack.front, spec,
                                      verify_objective, stack.history, workers,
                                      verified=stack.verified)
    result.designs = _merge_designs(carried, verify_objective, n_obj)
    if not result.designs:
        result.messages.append(
            "No design met every constraint. Try relaxing the tightest limit, "
            "widening a bound, or freeing another dimension.")
    else:
        best = result.designs[0]
        best_stack = next(s for s in carried if s.n == best["n_grains"])
        result.sensitivity = _sensitivity(
            best_stack.space, np.array(best["x"]), verify_objective, spec, workers)
        result.surrogate = best_stack.surrogate
    if result.surrogate is None:
        result.surrogate = next((s.surrogate for s in carried if s.surrogate), None)

    history = pd.concat([s.history for s in stacks if len(s.history)],
                        ignore_index=True) if any(len(s.history) for s in stacks) \
        else pd.DataFrame()
    objective = carried[0].objective
    searched = (list(base_space.names) if not several else
                ["n_grains"] + [n for n in base_space.names
                                if not n.startswith("core")])
    result.convergence = _convergence(history, objective, base_space)
    result.population = _population(history, verify_objective, base_space, searched)
    result.constraint_activity = _constraint_report(history, verify_objective,
                                                    base_space)
    sim_seconds = sum(s.sim_seconds for s in carried)
    stage_sims = sum(int(s.stage1["simulations"]) for s in stacks if s.stage1)
    result.stats = {
        "per_seed": [dict(row, n_grains=s.n) for s in carried for row in s.per_seed],
        "simulations": int(len(history)),
        # Only from a purely-simulation window: a multi-objective search
        # verifies inside its own timing, and those runs are not in history.
        "sim_rate": (round((len(history) - stage_sims) / sim_seconds
                           * (max(spec.search_timestep, 0.002) / 0.01) ** -0.75, 2)
                     if (sim_seconds > 0.5 and len(history) > stage_sims
                         and (spec.mode == "pareto" or n_obj == 1)) else None),
        "seeds": int(budget.get("seeds", 1)),
        "budget": int(budget.get("total", 0)),
        "seconds": round(time.time() - started, 1),
        "search_seconds": round(search_seconds, 1),
        "mode": spec.mode,
        "effort": spec.effort,
        "n_designs": len(result.designs),
        "objective_labels": objective.objective_labels,
        "searched": searched,
        "frozen": [v.name for v in base_space.specs if not v.free],
        "grain_counts": {
            "free": bool(spec.grain_count.free),
            "loaded": int(len(base_motor["grains"])),
            "stack_length": float(sum(g["properties"]["length"]
                                      for g in base_motor["grains"])),
            "counts": [s.n for s in stacks],
            "carried": [s.n for s in carried],
            "stage_generations": int(spec.grain_count.stage_generations),
            "stage1_simulations": int(stage_sims),
            "stacks": [s.summary() for s in stacks],
        },
    }
    on_progress("done", 1.0, "Finished")
    return result


# --- Grain counts: build, screen, try briefly, choose ---


def _build_stacks(spec: RunSpec, base_motor: Dict, baseline_metrics) -> List[_Stack]:
    """One search problem per grain count, each with its own timestep bias."""
    stacks = []
    for n in grain_counts(spec, base_motor):
        space = build_space(spec, base_motor, n)
        motor_n = space.base
        bias = timestep_bias(motor_n, spec.search_timestep, spec.verify_timestep)
        objective = build_objective(spec, baseline_metrics, bias)
        stacks.append(_Stack(n=n, space=space, objective=objective,
                             seeds=space.from_motor(motor_n)[None, :],
                             grain_length=float(space.grain_lengths[0])))
    return stacks


def _screen(stack: _Stack, spec: RunSpec, samples: int = 3000) -> Optional[str]:
    """Why no motor at this count can be legal, on paper, or None.

    Exact bound first: if Kn cannot be held with every core at its minimum and
    the throat at its maximum, nothing can. Then the sampled closed-form
    screen the settings page already uses.
    """
    from .sizing import estimate_feasible, tighten_bounds

    motor = stack.space.base
    throat = next((v for v in spec.variables if v.name == "throat"), None)
    try:
        tight = tighten_bounds(spec, motor)
        screened = estimate_feasible(spec, motor, samples=samples)
    except Exception:
        return None            # a screen that cannot run rules nothing out
    stack.screen = {
        "throat_low": tight.get("throat_low"),
        "core_high": tight.get("core_high"),
        "available": bool(screened.get("available")),
        "fraction": screened.get("fraction"),
        "hits": screened.get("hits"),
        "samples": screened.get("samples"),
    }
    floor = tight.get("throat_low")
    if throat is not None and floor is not None and floor >= throat.high - 1e-12:
        return ("Even with every core at its minimum, holding Kn needs a throat "
                "at least as wide as the largest allowed.")
    if screened.get("available") and not screened.get("hits"):
        return ("None of {:,} closed-form samples met Kn and port/throat "
                "together.".format(int(screened.get("samples", samples))))
    return None


def _stage_one(stacks: List[_Stack], spec: RunSpec, budget: Dict, n_obj: int,
               workers, on_progress, on_telemetry, meter: _Meter,
               window) -> None:
    """A short search per count, enough to rank them.

    Multi-objective counts are ranked on the hypervolume of their verified
    front; single-objective on the best legal score. A count with no legal
    design keeps how close it came, so the order is total.
    """
    gens = int(spec.grain_count.stage_generations)
    pop = int(budget["pop"])
    labels = None

    for k, stack in enumerate(stacks):
        lo, hi = _window(window[0], window[1], k, len(stacks))
        labels = stack.objective.objective_labels
        label = "Trying {} grains".format(stack.n)

        def tick(algorithm, stack=stack, lo=lo, hi=hi, k=k, label=label):
            done = getattr(algorithm, "n_gen", 0) or 0
            within = min(done / max(gens, 1), 1.0)
            on_progress("stage1", lo + (hi - lo) * within,
                        "{}: generation {} of {}".format(
                            label, min(int(done), gens), gens))
            frame = getattr(getattr(algorithm, "problem", None), "last_frame", None)
            snap = _snapshot(frame, stack.objective, stack.space, labels, done,
                             k, len(stacks))
            if snap is not None:
                snap.update(total_generations=gens, n_grains=stack.n,
                            stage="stage1")
                meter.stamp(snap, min(int(done), gens) * pop)
                on_telemetry(snap)

        seed = int(spec.seed) + 7919 * stack.n
        if n_obj > 1:
            out = direct_pareto(
                stack.space, stack.objective, pop_size=pop, n_gen=gens,
                timestep=spec.search_timestep, workers=workers, seed=seed,
                verify_timestep=spec.verify_timestep, seed_designs=stack.seeds,
                callback=tick)
            history = out.get("history", pd.DataFrame())
            front = out.get("front", pd.DataFrame())
        else:
            out = direct_search(
                stack.space, stack.objective, pop_size=pop, n_gen=gens,
                timestep=spec.search_timestep, workers=workers, seed=seed,
                callback=tick, seed_designs=stack.seeds)
            history = out.get("history", pd.DataFrame())
            front = _alternatives(stack.space, history, stack.objective, out["x"])
        meter.done += int(len(history))

        score, near = None, None
        if len(history):
            violation = scale_constraints(history, stack.objective, stack.space).max(axis=1)
            feasible = history["ok"].to_numpy(dtype=bool) & (violation <= 0)
            if feasible.any():
                score = float(stack.objective.score_frame(history[feasible]).max())
            near = float(-violation.min())
        stack.stage1 = {"simulations": int(len(history)), "score": score,
                        "near": near, "front": front,
                        "designs": int(len(front)),
                        "hypervolume": None, "rank": None}
        stack.history = history.assign(n_grains=stack.n) if len(history) else history
        if len(front):
            X = stack.space.canonicalize(front[stack.space.names].to_numpy(dtype=float))
            stack.seeds = np.vstack([stack.seeds, X])

    if n_obj > 1:
        _hypervolumes(stacks)


def _hypervolumes(stacks: List[_Stack]) -> None:
    """Hypervolume of each count's first-stage front, one reference point for all.

    Fronts are normalised against the same baselines, so they share axes. The
    reference sits just past the worst value any front reaches.
    """
    from pymoo.indicators.hv import HV

    fronts = {}
    for stack in stacks:
        front = stack.stage1.get("front") if stack.stage1 else None
        if front is not None and len(front):
            fronts[stack.n] = stack.objective.matrix(front)
    if not fronts:
        return
    indicator = HV(ref_point=_hv_reference(np.vstack(list(fronts.values()))))
    for stack in stacks:
        F = fronts.get(stack.n)
        if F is None:
            continue
        hv = float(indicator(F))
        stack.stage1["hypervolume"] = hv
        stack.stage1["score"] = hv


def _select(stacks: List[_Stack], spec: RunSpec) -> None:
    """Which counts go on to the full search.

    The best ``carry`` by first-stage score, plus any within ``carry_within``
    of the leader. Counts with no legal design rank after every count with
    one, closest first, so a run that found nothing still carries something.
    """
    gc = spec.grain_count

    def key(stack: _Stack):
        s = stack.stage1 or {}
        score, near = s.get("score"), s.get("near")
        legal = score is not None
        return (0 if legal else 1,
                -(score if legal else (near if near is not None else -np.inf)))

    ordered = sorted(stacks, key=key)
    legal = [s for s in ordered if s.stage1 and s.stage1.get("score") is not None]
    cut = None
    if legal:
        leader = float(legal[0].stage1["score"])
        cut = leader - abs(leader) * float(gc.carry_within)
    for rank, stack in enumerate(ordered):
        score = (stack.stage1 or {}).get("score")
        within = cut is not None and score is not None and score >= cut
        stack.carried = rank < int(gc.carry) or within
        if stack.stage1 is not None:
            stack.stage1["rank"] = rank + 1


def _search_stack(stack: _Stack, spec: RunSpec, budget: Dict, n_obj: int,
                  workers, on_progress, on_telemetry, meter: _Meter, window,
                  several: bool) -> None:
    """The full search at one count, exactly as a fixed-count run does it."""
    if spec.mode == "pareto":
        out = _surrogate_search(stack.space, stack.objective, spec, budget,
                                stack.seeds, workers, on_progress, on_telemetry,
                                meter, window, stack.n if several else None,
                                known=stack.history)
        stack.surrogate = out.get("surrogate")
        stack.verified = True
    else:
        out = _multi_seed_search(stack.space, stack.objective, spec, budget,
                                 stack.seeds, n_obj, workers, on_progress,
                                 on_telemetry, meter, window,
                                 stack.n if several else None)
    stack.front = out["front"]
    stack.per_seed = out["per_seed"]
    stack.sim_seconds = float(out.get("sim_seconds", 0.0))
    history = out.get("history", pd.DataFrame())
    if len(history):
        history = history.assign(n_grains=stack.n)
        stack.history = (pd.concat([stack.history, history], ignore_index=True)
                         if len(stack.history) else history)


def _design_key(x: np.ndarray):
    """The rounded vector, so every stage agrees on what a repeat is."""
    return tuple(np.round(np.asarray(x, dtype=float), 6))


def _legal(frame: pd.DataFrame, objective: Objective,
           space: DesignSpace) -> np.ndarray:
    """Rows that simulated and clear every limit of ``objective``."""
    violation = scale_constraints(frame, objective, space).max(axis=1)
    return frame["ok"].to_numpy(dtype=bool) & (violation <= 0)


def _hv_reference(F: np.ndarray) -> np.ndarray:
    """A reference point just past the worst value any row reaches."""
    worst, best = F.max(axis=0), F.min(axis=0)
    return worst + 0.05 * np.maximum(worst - best, 1e-9)


def _merge_designs(stacks: List[_Stack], objective: Objective,
                   n_obj: int, cap: int = MAX_DESIGNS) -> List[Dict]:
    """Every count's verified designs, as one ranked list.

    Compared on metrics alone, since the design vectors differ in length. The
    non-dominated set is taken again across counts.
    """
    designs = []
    seen = set()
    for stack in stacks:
        for d in stack.designs:
            # Seeds converge on the same motor; one copy is enough.
            x = d.get("x")
            key = (stack.n, _design_key(x)) if x else None
            if key is not None and key in seen:
                continue
            if key is not None:
                seen.add(key)
            designs.append(d)
    if not designs:
        return []
    frame = pd.DataFrame([{m: d.get(m) for m in OPTIMISABLE_METRICS} for d in designs])
    frame["ok"] = True
    if n_obj > 1 and len(designs) > 1:
        keep = pareto_indices(-objective.matrix(frame))
        designs = [designs[i] for i in keep]
        frame = frame.iloc[keep].reset_index(drop=True)
        if len(designs) > cap:      # keep the front readable, spread across it
            order = np.argsort(-frame[objective.objective_labels[0]].to_numpy(dtype=float))
            picked = np.unique(order[np.linspace(0, len(order) - 1, cap).round().astype(int)])
            designs = [designs[i] for i in picked]
            frame = frame.iloc[picked].reset_index(drop=True)
    score = objective.score_frame(frame)
    out = []
    for rank, i in enumerate(np.argsort(-score, kind="stable")):
        design = dict(designs[i])
        design["label"] = "Option {}".format(rank + 1)
        out.append(design)
    return out


def _surrogate_search(space: DesignSpace, objective: Objective, spec: RunSpec,
                      budget: Dict, seeds: np.ndarray, workers, on_progress,
                      on_telemetry: TelemetryFn, meter: _Meter, window,
                      n_grains: Optional[int] = None,
                      known: Optional[pd.DataFrame] = None) -> Dict:
    """Sample once, then rounds of: fit, search the model, simulate its picks.

    A model fitted to a space-filling sample is least accurate at the
    constraint boundary, which is where the front sits. Simulating what the
    model proposes each round puts the data there, so by the last round the
    model is accurate where the answer is. The front is taken from simulated
    designs only, verified at the fine timestep as the full search does.

    ``known`` holds burns already made in this space at the search timestep.
    They train the model and may reach the front, but are never re-simulated
    and are not counted in the returned history.
    """
    lo, hi = window
    span = hi - lo
    at = lambda f: lo + span * f  # noqa: E731
    tag = " ({} grains)".format(n_grains) if n_grains else ""
    n_seeds = max(1, int(budget.get("seeds", 1)))
    rounds = int(budget["rounds"])
    labels = objective.objective_labels
    targets = needed_targets(objective)
    baseline_x = np.atleast_2d(seeds)[0]
    sim_seconds = 0.0
    known = known if known is not None and len(known) else pd.DataFrame()
    n_known = int(len(known))
    seen: set = set()

    with SimulationPool(space, timestep=spec.search_timestep, workers=workers) as pool:
        on_progress("sampling", at(0.0), "Sampling the design space" + tag)
        started = time.time()
        sample = pool.evaluate(mixed_designs(space, budget["initial"], seed=spec.seed))
        sim_seconds += time.time() - started
        meter.done += int(len(sample))
        dataset = pd.concat([known, sample], ignore_index=True) if n_known else sample
        seen.update(_design_key(x) for x in dataset[space.names].to_numpy(dtype=float))

        surrogate = Surrogate(space, kind="gbt", seed=spec.seed)
        per_round: List[Dict] = []
        stale, front_F = 0, None
        for r in range(rounds):
            on_progress("training", at(0.30 + 0.60 * r / rounds),
                        "Round {} of {}{}: training the model".format(r + 1, rounds, tag))
            # Every burn teaches the model; scoring waits for the final fit.
            surrogate.fit(dataset, targets=targets, test_size=0.0)
            starts = np.vstack([np.atleast_2d(seeds),
                                _seed_designs(dataset, space, objective, baseline_x)])
            proposed = []
            for index in range(n_seeds):
                def tick(algorithm, index=index, r=r):
                    """Same live view as the simulator path, over predictions."""
                    done = getattr(algorithm, "n_gen", 0) or 0
                    within = min(done / max(SURROGATE_GEN, 1), 1.0)
                    on_progress("search", at(0.30 + 0.60 * (r + 0.2 + 0.5 * (index + within)
                                                             / n_seeds) / rounds),
                                "Round {} of {}{}: searching the model, {} of {}".format(
                                    r + 1, rounds, tag, index + 1, n_seeds))
                    frame = getattr(getattr(algorithm, "problem", None),
                                    "last_frame", None)
                    snap = _snapshot(frame, objective, space, labels, done, index,
                                     n_seeds, surrogate=True)
                    if snap is not None:
                        snap["total_generations"] = int(SURROGATE_GEN)
                        snap["stage"] = "search"
                        if n_grains:
                            snap["n_grains"] = int(n_grains)
                        meter.stamp(snap, 0)
                        on_telemetry(snap)

                proposed.append(surrogate_candidates(
                    space, surrogate, objective, pop_size=SURROGATE_POP,
                    n_gen=SURROGATE_GEN, seed=int(spec.seed) + 1009 * index + 31 * r,
                    seed_designs=starts, callback=tick))
            X = _infill(space, surrogate, objective, proposed, seen, int(budget["infill"]))
            if not len(X):
                break
            on_progress("infill", at(0.30 + 0.60 * (r + 0.7) / rounds),
                        "Round {} of {}{}: simulating {} designs the model proposed"
                        .format(r + 1, rounds, tag, len(X)))
            started = time.time()
            batch = pool.evaluate(X)
            sim_seconds += time.time() - started
            meter.done += int(len(batch))
            seen.update(_design_key(x) for x in X)
            dataset = pd.concat([dataset, batch], ignore_index=True)
            # The live view gets real motors, so the best-so-far download works.
            snap = _snapshot(batch, objective, space, labels, r + 1, 0, 1)
            if snap is not None:
                snap.update(total_generations=rounds, stage="infill")
                if n_grains:
                    snap["n_grains"] = int(n_grains)
                meter.stamp(snap, 0)
                on_telemetry(snap)
            hv, before, front_F = _front_hypervolume(dataset, objective, space, front_F)
            per_round.append({"round": r + 1, "simulated": int(len(batch)),
                              "legal": int(_legal(batch, objective, space).sum()),
                              "hypervolume": hv})
            # Three rounds without the front moving and the model has run out
            # of things to teach it; the rest of the budget would be wasted.
            # Rounds with no front yet do not count: those are the rounds
            # the infill exists for.
            if hv is None:
                continue
            if before is None or hv > before + abs(before) * 1e-3:
                stale = 0
            else:
                stale += 1
            if stale >= 3:
                break

    on_progress("training", at(0.92), "Scoring the model" + tag)
    scores = surrogate.fit(dataset)
    surrogate_info = {
        "kind": surrogate.kind,
        "scores": [s.as_row() for s in scores],
        "importances": surrogate.importances(
            dataset, labels[0]).head(12).to_dict("records"),
        "parity": _parity_sample(surrogate, dataset, space),
        "n_grains": n_grains,
        "rounds": per_round,
    }
    on_progress("verify", at(0.95), "Verifying the front" + tag)
    front = _simulated_front(space, dataset, objective, spec, workers)
    return {"front": front, "history": dataset.iloc[n_known:].reset_index(drop=True),
            "surrogate": surrogate_info, "sim_seconds": sim_seconds,
            "per_seed": per_round}


def _infill(space: DesignSpace, surrogate: Surrogate, objective: Objective,
            proposed: List[Dict], seen: set, count: int) -> np.ndarray:
    """Which of the model's proposals to simulate this round.

    Every search's predicted front first, spread evenly along it when there
    are more than fit, then the closing populations. Designs already
    simulated are skipped: the grid makes repeats common.
    """
    taken: set = set()

    def fresh(X: np.ndarray) -> np.ndarray:
        picked = []
        for x in np.atleast_2d(X):
            k = _design_key(x)
            if k in seen or k in taken:
                continue
            taken.add(k)
            picked.append(x)
        return np.array(picked, dtype=float).reshape(-1, space.n_dim)

    front = fresh(np.vstack([p["front"] for p in proposed]))
    if len(front) > count:
        pred = surrogate.predict(front)
        order = np.argsort(-pred[objective.objective_labels[0]].to_numpy(dtype=float))
        pick = order[np.linspace(0, len(order) - 1, count).round().astype(int)]
        return front[np.unique(pick)]
    rest = fresh(np.vstack([p["population"] for p in proposed]))
    room = count - len(front)
    if len(rest) > room:
        pred = surrogate.predict(rest)
        pred["ok"] = True
        # Nearest to legal first; among the legal, best predicted score.
        over = np.maximum(scale_constraints(pred, objective, space).max(axis=1), 0.0)
        rank = over * 1e3 - objective.score_frame(pred)
        rest = rest[np.argsort(rank)[:room]]
    return np.vstack([front, rest])


def _front_hypervolume(dataset: pd.DataFrame, objective: Objective,
                       space: DesignSpace,
                       previous: Optional[np.ndarray] = None):
    """Hypervolume of the legal, simulated front, as ``(now, before, F)``.

    The reference sits past the worst legal design simulated so far, so a
    front that grows outward still counts. ``previous`` is the last front's
    ``F``, measured against this round's reference, so ``now - before`` is
    the growth. Without a legal design ``now`` is None and ``F`` is
    ``previous``.
    """
    from pymoo.indicators.hv import HV

    good = dataset[_legal(dataset, objective, space)]
    if not len(good):
        return None, None, previous
    every = objective.matrix(good)
    F = every[pareto_indices(-every)]
    if F.shape[1] < 2:
        before = float(-previous.min()) if previous is not None else None
        return float(-F.min()), before, F
    seen = every if previous is None else np.vstack([every, previous])
    indicator = HV(ref_point=_hv_reference(seen))
    before = float(indicator(previous)) if previous is not None else None
    return float(indicator(F)), before, F


def _simulated_front(space: DesignSpace, dataset: pd.DataFrame,
                     objective: Objective, spec: RunSpec,
                     workers: Optional[int]) -> pd.DataFrame:
    """The front of everything simulated, re-run at the fine timestep.

    The next layer behind the front comes too: a point that fails the fine
    check leaves a hole, and the design behind it is the one to fill it.
    The rows returned carry the fine-timestep metrics.
    """
    good = dataset[_legal(dataset, objective, space)]
    if not len(good):
        return pd.DataFrame()
    layers = []
    remaining = good.reset_index(drop=True)
    for _ in range(2):
        if not len(remaining):
            break
        picked = pareto_indices(-objective.matrix(remaining))
        layers.append(remaining.iloc[picked])
        remaining = remaining.drop(remaining.index[picked]).reset_index(drop=True)
    candidates = pd.concat(layers, ignore_index=True).drop_duplicates(space.names)
    candidates = candidates.sort_values(objective.objective_labels[0], ascending=False)
    if len(candidates) > 2 * MAX_DESIGNS:  # thin evenly along the front
        pick = np.linspace(0, len(candidates) - 1, 2 * MAX_DESIGNS).round().astype(int)
        candidates = candidates.iloc[np.unique(pick)]
    X = space.canonicalize(candidates[space.names].to_numpy(dtype=float))
    verified = evaluate_batch(space, X, timestep=spec.verify_timestep,
                              workers=workers)
    keep = verified[_legal(verified, objective.strict(), space)].reset_index(drop=True)
    if not len(keep):
        return pd.DataFrame()
    front = keep.iloc[pareto_indices(-objective.matrix(keep))]
    return front.sort_values(objective.objective_labels[0],
                             ascending=False).reset_index(drop=True)


def _alternatives(space: DesignSpace, history: pd.DataFrame,
                  objective: Objective, best_x: np.ndarray,
                  count: int = 14) -> pd.DataFrame:
    """The winner plus the best genuinely different designs behind it.

    Deduplicated on the rounded vector, since a run ends clustered on one motor.
    """
    columns = list(space.names)
    rows = [pd.DataFrame([dict(zip(columns, best_x))])]
    if len(history):
        violation = scale_constraints(history, objective, space).max(axis=1)
        good = history[history["ok"].to_numpy(dtype=bool) & (violation <= 0)]
        if len(good):
            ranked = good.assign(_score=objective.score_frame(good)).sort_values(
                "_score", ascending=False)
            seen = {_design_key(best_x)}
            picked = []
            for _, row in ranked.iterrows():
                key = _design_key(row[columns].to_numpy(dtype=float))
                if key in seen:
                    continue
                seen.add(key)
                picked.append(row[columns])
                if len(picked) >= count - 1:
                    break
            if picked:
                rows.append(pd.DataFrame(picked))
    return pd.concat(rows, ignore_index=True)


def _multi_seed_search(space: DesignSpace, objective: Objective, spec: RunSpec,
                       budget: Dict, seeds: np.ndarray, n_obj: int,
                       workers, on_progress,
                       on_telemetry: TelemetryFn = _noop_telemetry,
                       meter: Optional[_Meter] = None, window=(0.08, 0.88),
                       n_grains: Optional[int] = None) -> Dict:
    """Several independent searches, merged into one front.

    A genetic search converges on whichever basin it started in, so splitting
    the budget across seeds and merging beats spending it all on one search.
    """
    n_seeds = max(1, int(budget.get("seeds", 1)))
    meter = meter or _Meter(budget["total"])
    lo, hi = window
    tag = " ({} grains)".format(n_grains) if n_grains else ""
    seeds = np.atleast_2d(np.asarray(seeds, dtype=float))
    fronts, histories, per_seed = [], [], []
    started = time.time()

    for index in range(n_seeds):
        seed = int(spec.seed) + 1009 * index      # spread, not consecutive
        label = "search {} of {}{}".format(index + 1, n_seeds, tag)

        labels = objective.objective_labels

        def tick(algorithm, index=index, label=label):
            done = getattr(algorithm, "n_gen", 0) or 0
            within = min(done / max(budget["gen"], 1), 1.0)
            on_progress("search", lo + (hi - lo) * (index + within) / n_seeds,
                        "{}: generation {} of {}".format(
                            label, min(int(done), budget["gen"]), budget["gen"]))
            frame = getattr(getattr(algorithm, "problem", None), "last_frame", None)
            snap = _snapshot(frame, objective, space, labels, done, index, n_seeds)
            if snap is not None:
                snap["total_generations"] = int(budget["gen"])
                snap["stage"] = "search"
                if n_grains:
                    snap["n_grains"] = int(n_grains)
                meter.stamp(snap, (index * budget["gen"] + min(int(done), budget["gen"]))
                            * budget["pop"])
                on_telemetry(snap)

        if n_obj > 1:
            out = direct_pareto(
                space, objective, pop_size=budget["pop"], n_gen=budget["gen"],
                timestep=spec.search_timestep, workers=workers, seed=seed,
                verify_timestep=spec.verify_timestep,
                seed_designs=seeds, callback=tick)
            found = out.get("front", pd.DataFrame())
        else:
            out = direct_search(
                space, objective, pop_size=budget["pop"], n_gen=budget["gen"],
                timestep=spec.search_timestep, workers=workers, seed=seed,
                callback=tick, seed_designs=seeds)
            found = _alternatives(space, out.get("history", pd.DataFrame()),
                                  objective, out["x"])
        if len(found):
            found = found.copy()
            found["seed"] = seed
            fronts.append(found)
        history = out.get("history", pd.DataFrame())
        histories.append(history)
        per_seed.append({"seed": seed, "designs": int(len(found)),
                         "simulations": int(len(history))})
    meter.done += int(sum(len(h) for h in histories))

    combined = pd.concat(fronts, ignore_index=True) if fronts else pd.DataFrame()
    if len(combined) and n_obj > 1:
        combined = combined.iloc[pareto_indices(-objective.matrix(combined))]
        combined = combined.reset_index(drop=True)
    return {"front": combined,
            "history": pd.concat(histories, ignore_index=True) if histories
                       else pd.DataFrame(),
            "per_seed": per_seed,
            "sim_seconds": time.time() - started}


def _seed_designs(dataset: pd.DataFrame, space: DesignSpace,
                  objective: Objective, baseline_x: np.ndarray) -> np.ndarray:
    """Baseline plus the best already-sampled designs, as a starting population."""
    usable = dataset[dataset["ok"]]
    if not len(usable):
        return baseline_x[None, :]
    ranked = usable.assign(_score=objective.score_frame(usable)).nlargest(
        60, "_score")
    return np.vstack([baseline_x[None, :],
                      space.canonicalize(ranked[space.names].to_numpy(dtype=float))])


def _rank_designs(space: DesignSpace, front: pd.DataFrame, spec: RunSpec,
                  objective: Objective, history: pd.DataFrame,
                  workers: Optional[int] = None,
                  verified: bool = False) -> List[Dict]:
    """Verifies each candidate and keeps only those that clear every limit.

    ``verified`` says the rows already hold fine-timestep metrics, so the
    burns are not repeated.
    """
    if not len(front):
        return []
    if len(front) > MAX_DESIGNS:  # keep the front readable, spread across it
        keep = np.linspace(0, len(front) - 1, MAX_DESIGNS).round().astype(int)
        front = front.iloc[np.unique(keep)]
    if verified:
        checked = front.reset_index(drop=True)
    else:
        X = space.canonicalize(front[space.names].to_numpy(dtype=float))
        checked = evaluate_batch(space, X, timestep=spec.verify_timestep,
                                 workers=workers)
    good = checked[_legal(checked, objective.strict(), space)]
    if not len(good):
        return []
    axes = -objective.matrix(good)
    kept = good.iloc[pareto_indices(axes)] if axes.shape[1] > 1 else good
    kept = kept.assign(_score=objective.score_frame(kept)).sort_values(
        "_score", ascending=False)
    designs = []
    fields = {f.name for f in dataclass_fields(Metrics)} - {"warnings"}
    for rank, (_, row) in enumerate(kept.iterrows()):
        x = space.canonical_one(row[space.names].to_numpy(dtype=float))
        # Plain Python scalars, NaN kept: the output serialiser nulls it.
        values = {k: (v.item() if isinstance(v, np.generic) else v)
                  for k, v in row.items() if k in fields}
        values["warnings"] = [w for w in str(row.get("warnings", "")).split("; ") if w]
        metrics = Metrics(**values)
        designs.append(describe_design(space, x, spec,
                                       "Option {}".format(rank + 1),
                                       with_curves=rank < 6, metrics=metrics))
    return designs


def _parity_sample(surrogate: Surrogate, dataset: pd.DataFrame,
                   space: DesignSpace, cap: int = 1500) -> Dict:
    """Predicted-vs-simulated points for the diagnostics profile."""
    usable = dataset[dataset["ok"]]
    sample = usable.sample(min(cap, len(usable)), random_state=0)
    predicted = surrogate.predict(sample[space.names].to_numpy(dtype=float))
    out = {}
    for target in predicted.columns:
        if target in sample.columns:
            out[target] = {
                "actual": sample[target].to_numpy(dtype=float).tolist(),
                "predicted": predicted[target].to_numpy(dtype=float).tolist(),
            }
    return out
