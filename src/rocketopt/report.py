"""Builds the technical report for one or more optimisation runs.

Everything is derived from the runs themselves, so nothing about any particular
motor is written into this file. An empty run gets the most attention: which
limit could never be met, how close anything got, and what would change that.
"""

from __future__ import annotations

import base64
import html
import math
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Sequence

import numpy as np

from .design import DesignSpace
from .pdf import NoBrowser, html_to_pdf
from .report_style import CSS, FONT_LINK
from .runner import build_space, motor_for
from .simulate import PA_PER_PSI, curves, simulate_motor
from .spec import OPTIMISABLE_METRICS, RunSpec
from .units import KG_M2S_PER_LB_IN2S as LB
from .units import M_PER_IN as IN

#: Whose tool this is. Carried on every report the app generates.
AUTHOR = "Lior Benshoshan"


def _today() -> str:
    return date.today().strftime("%-d %B %Y")


#: How many designs to tabulate off a front. Enough to show the shape of the
#: trade, few enough to read without scrolling.
N_OPTIONS = 7


class ReportFiles(NamedTuple):
    """What a finished report leaves on disk: one file.

    ``pdf`` is the report. ``html`` is set only when no browser was available to
    render one, in which case the HTML is the report instead and ``pdf_error``
    says what went wrong. Exactly one of the two is ever populated.
    """

    pdf: Optional[Path] = None
    html: Optional[Path] = None
    pdf_error: str = ""

    @property
    def path(self) -> Path:
        """The file to hand over, whichever form it took."""
        return self.pdf or self.html


@dataclass
class ReportRun:
    """One optimisation, with everything needed to write about it."""

    label: str
    result: Dict          # RunResult.to_dict()
    spec: RunSpec

    @property
    def designs(self) -> List[Dict]:
        return sorted(self.result.get("designs", []),
                      key=lambda d: -d["initial_thrust"])

    @property
    def feasible(self) -> bool:
        return bool(self.result.get("designs"))

# --- Display helpers ---


@dataclass
class Units:
    """The unit system a report is written in. Storage is SI throughout."""

    length: str = "in"
    length_scale: float = IN
    length_places: int = 2
    pressure: str = "psi"
    pressure_scale: float = PA_PER_PSI
    pressure_places: int = 0
    flux: str = "lb/in²s"
    flux_scale: float = LB
    flux_places: int = 3

    @classmethod
    def from_spec(cls, spec: Optional[RunSpec]) -> "Units":
        chosen = (spec.display_units if spec is not None else None) or {}
        if chosen.get("length") == "mm":
            return cls(length="mm", length_scale=0.001, length_places=1,
                       pressure="MPa", pressure_scale=1e6, pressure_places=2,
                       flux="kg/m²s", flux_scale=1.0, flux_places=0)
        return cls()


#: Whichever report is being written. Set by the entry points, read by every
#: formatter, so one choice reaches every number.
_U = Units()


def set_units(spec: Optional[RunSpec]) -> Units:
    global _U
    _U = Units.from_spec(spec)
    return _U


def length_unit() -> str:
    return _U.length


def dim(value: float, places: Optional[int] = None) -> str:
    """A length in the report's unit, to the shop's usual places."""
    places = _U.length_places if places is None else places
    return "{:.{}f}".format(value / _U.length_scale, places)


def dim_exact(value: float) -> str:
    """Grid places on the machining grid, two more off it.

    1.2953 in reported as 1.30 is the number someone would then cut.
    """
    shown = value / _U.length_scale
    grid = 10 ** _U.length_places
    on_grid = abs(shown * grid - round(shown * grid)) < 1e-6
    return "{:.{}f}".format(shown, _U.length_places if on_grid
                            else _U.length_places + 2)


#: Kept for callers that predate the unit choice.
inches = dim
inches_exact = dim_exact


def collapse(variables) -> list:
    """Groups the per-grain cores into one row when they share bounds."""
    cores = [v for v in variables if v.name.startswith("core")]
    rest = [v for v in variables if not v.name.startswith("core")]
    out = []
    if cores:
        same = all((v.low, v.high, v.step, v.free) ==
                   (cores[0].low, cores[0].high, cores[0].step, cores[0].free)
                   for v in cores)
        if same:
            out.append(("Grain cores × {}".format(len(cores)), cores[0]))
        else:
            out.extend((v.label or v.name, v) for v in cores)
    out.extend((v.label or v.name, v) for v in rest)
    return out


def display(metric: str, value: float) -> float:
    kind = OPTIMISABLE_METRICS.get(metric, {}).get("kind")
    if kind == "pressure":
        return value / _U.pressure_scale
    if kind == "mass_flux":
        return value / _U.flux_scale
    return value


def metric_label(metric: str) -> str:
    return OPTIMISABLE_METRICS.get(metric, {}).get("label", metric)


def metric_unit(metric: str) -> str:
    kind = OPTIMISABLE_METRICS.get(metric, {}).get("kind")
    if kind == "pressure":
        return _U.pressure
    if kind == "mass_flux":
        return _U.flux
    return OPTIMISABLE_METRICS.get(metric, {}).get("unit", "")


def metric_places(metric: str) -> int:
    kind = OPTIMISABLE_METRICS.get(metric, {}).get("kind")
    if kind == "pressure":
        return _U.pressure_places
    if kind == "mass_flux":
        return _U.flux_places
    return int(OPTIMISABLE_METRICS.get(metric, {}).get("places", 0))


def esc(text) -> str:
    return html.escape(str(text))


def pick_options(designs: Sequence[Dict], count: int = N_OPTIONS) -> List[Dict]:
    """Designs spread along the leading objective, not just the best few.

    The top N off a front are N variations on one motor.
    """
    if len(designs) <= count:
        return list(designs)
    values = [d["initial_thrust"] for d in designs]
    lo, hi = min(values), max(values)
    chosen, used = [], set()
    for i in range(count):
        target = hi - (hi - lo) * i / (count - 1)
        best = min((d for d in designs if id(d) not in used),
                   key=lambda d: abs(d["initial_thrust"] - target))
        used.add(id(best))
        chosen.append(best)
    return chosen


def balanced_index(options: Sequence[Dict], metrics: Sequence[str]) -> int:
    """The option conceding least on any objective, as a fraction of the best
    value available for that objective."""
    if not options:
        return 0
    best = {m: max(o[m] for o in options) for m in metrics}
    scores = [min(o[m] / best[m] if best[m] else 1.0 for m in metrics)
              for o in options]
    return int(np.argmax(scores))


# --- Diagnosing a run that found nothing ---


def diagnose(run: ReportRun, base_motor: Dict) -> Dict:
    """Why an empty run was empty, in terms a builder can act on.

    The limit nothing satisfied, how close the best attempt came, and whether
    the geometry can meet Kn at any core diameter.
    """
    space = build_space(run.spec, base_motor)
    population = run.result.get("population", [])
    activity = run.result.get("constraint_activity", [])

    worst = max(activity, key=lambda c: c.get("violated_fraction", 0.0)) if activity else None
    closest = None
    if population:
        # Rank by the single worst limit each design broke, then report the best.
        def overshoot(row):
            over = []
            for c in run.spec.enabled_constraints:
                value = row.get(c.metric)
                if value is None:
                    continue
                over.append(value / c.value - 1.0 if c.op == "<="
                            else c.value / max(value, 1e-9) - 1.0)
            return max(over) if over else 0.0
        closest = min(population, key=overshoot)
        closest = {**closest, "overshoot": overshoot(closest)}

    sweep = _kn_sweep(space, run.spec)
    return {"worst": worst, "closest": closest, "sweep": sweep,
            "n_tried": run.result.get("stats", {}).get("simulations", 0)}


def _kn_sweep(space: DesignSpace, spec: RunSpec) -> Optional[Dict]:
    """Kn at ignition against a uniform core diameter, with the throat held.

    Only meaningful with the throat fixed: a throat that can open puts no core
    diameter out of reach.
    """
    throat_free = any(v.name == "throat" and v.free for v in spec.variables)
    kn_limit = next((c.value for c in spec.enabled_constraints
                     if c.metric == "peak_kn" and c.op == "<="), None)
    if throat_free or kn_limit is None:
        return None

    throat = next(v for v in spec.variables if v.name == "throat")
    throat_d = throat.fixed_value if throat.fixed_value is not None else throat.low
    throat_area = math.pi * throat_d**2 / 4
    diameter = space.grain_diameter
    length = float(space.grain_lengths[0])
    n = space.n_grains
    core = next(v for v in spec.variables if v.name.startswith("core"))

    cores = np.linspace(core.low, core.high, 160)
    area = n * (math.pi * cores * length + (math.pi / 2) * (diameter**2 - cores**2))
    kn = area / throat_area
    # Smallest throat that would put the *lowest* achievable area under the limit
    min_throat = math.sqrt(4 * area.min() / kn_limit / math.pi)
    return {
        "throat_in": throat_d / _U.length_scale,
        "throat_area_in2": throat_area / _U.length_scale**2,
        "kn_limit": kn_limit,
        "area_cap_in2": kn_limit * throat_area / _U.length_scale**2,
        "cores_in": (cores / _U.length_scale).tolist(),
        "kn": kn.tolist(),
        "kn_min": float(kn.min()),
        "area_min_in2": float(area.min() / _U.length_scale**2),
        "grows_with_core": bool(length > core.high),
        "min_throat_in": min_throat / _U.length_scale,
        "grain_diameter_in": diameter / _U.length_scale,
        "grain_length_in": length / _U.length_scale,
        "n_grains": n,
    }


# --- Figures ---


def make_figures(runs: Sequence[ReportRun], base_motor: Dict,
                 out_dir: Path) -> Dict[str, Path]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from . import plotting
    from .plotting import LIMIT, SERIES, SURFACE

    out_dir.mkdir(parents=True, exist_ok=True)
    plotting.apply_style()
    made: Dict[str, Path] = {}
    ramp = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]

    for index, run in enumerate(runs):
        key = "run{}".format(index)
        designs = run.designs
        baseline = run.result.get("baseline", {})
        metrics = run.result.get("stats", {}).get("objective_labels", [])

        if designs and len(metrics) >= 2:
            ax_x, ax_y = metrics[1], metrics[0]
            front = sorted(designs, key=lambda d: d[ax_x])
            options = pick_options(designs)
            fig, ax = plt.subplots(figsize=(8.4, 5.3))
            ax.plot([display(ax_x, d[ax_x]) for d in front],
                    [display(ax_y, d[ax_y]) for d in front],
                    "-", color=SERIES[0], linewidth=2,
                    label="legal designs ({})".format(len(designs)))
            ax.scatter([display(ax_x, o[ax_x]) for o in options],
                       [display(ax_y, o[ax_y]) for o in options],
                       s=62, color=SERIES[0], edgecolors=SURFACE, linewidths=1.6,
                       zorder=4, label="tabulated options")
            for i, o in enumerate(options, 1):
                ax.annotate(str(i), xy=(display(ax_x, o[ax_x]), display(ax_y, o[ax_y])),
                            xytext=(0, 11), textcoords="offset points", ha="center",
                            fontsize=9, fontweight="700", color=SERIES[0])
            if baseline:
                ax.scatter([display(ax_x, baseline[ax_x])],
                           [display(ax_y, baseline[ax_y])], s=126, marker="D",
                           color=LIMIT, edgecolors=SURFACE, linewidths=1.5, zorder=5)
                ax.annotate("the motor as loaded", xy=(display(ax_x, baseline[ax_x]),
                                                        display(ax_y, baseline[ax_y])),
                            xytext=(-14, -34), textcoords="offset points", ha="right",
                            fontsize=9, color=LIMIT, fontweight="600",
                            arrowprops=dict(arrowstyle="-", color=LIMIT,
                                            linewidth=0.9, shrinkA=0, shrinkB=6))
            ax.set_xlabel(_axis(ax_x))
            ax.set_ylabel(_axis(ax_y))
            ax.set_title("What this motor can do inside the configured limits")
            ax.legend(loc="lower left")
            _tidy(ax)
            made[key + "_front"] = _save(fig, out_dir / (key + "_front.png"))

            fig, ax = plt.subplots(figsize=(8.4, 4.6))
            space = build_space(run.spec, base_motor)
            for i, o in enumerate(options, 1):
                trace = curves(motor_for(o, space), timestep=0.002)
                ax.plot(trace["time"], trace["thrust"],
                        color=ramp[(i - 1) % len(ramp)], linewidth=1.9,
                        label="{} · {:,.0f} {}".format(i, display(ax_x, o[ax_x]),
                                                       metric_unit(ax_x)))
            ax.set_xlabel("Time (s)"); ax.set_ylabel("Thrust (N)")
            ax.set_title("Thrust curves for the tabulated options")
            ax.set_xlim(left=0); ax.set_ylim(bottom=0)
            ax.legend(loc="upper right", fontsize=8.5, ncol=2)
            _tidy(ax)
            made[key + "_curves"] = _save(fig, out_dir / (key + "_curves.png"))

        elif not designs:
            sweep = diagnose(run, base_motor).get("sweep")
            if sweep:
                fig, ax = plt.subplots(figsize=(8.4, 4.3))
                ax.plot(sweep["cores_in"], sweep["kn"], color=SERIES[0], linewidth=2.2)
                ax.axhline(sweep["kn_limit"], color=LIMIT, linewidth=1.4, linestyle="--")
                ax.annotate("Kn limit {:.0f}".format(sweep["kn_limit"]),
                            xy=(sweep["cores_in"][0], sweep["kn_limit"]),
                            xytext=(0, 8), textcoords="offset points",
                            color=LIMIT, fontsize=9, fontweight="600")
                kn = np.array(sweep["kn"])
                ax.fill_between(sweep["cores_in"], sweep["kn_limit"], kn,
                                where=(kn >= sweep["kn_limit"]), color=LIMIT, alpha=0.10)
                ax.set_xlabel("Core diameter, every grain ({})".format(_U.length))
                ax.set_ylabel("Kn with the {} {} throat".format(
                    "{:.4f}".format(sweep["throat_in"]).rstrip("0").rstrip("."), _U.length))
                ax.set_title("No core diameter keeps Kn legal, even before the burn starts")
                _tidy(ax)
                made[key + "_infeasible"] = _save(fig, out_dir / (key + "_infeasible.png"))
    return made


def _axis(metric: str) -> str:
    unit = metric_unit(metric)
    return metric_label(metric) + (" ({})".format(unit) if unit else "")


def _tidy(ax) -> None:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def _save(fig, path: Path) -> Path:
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    import matplotlib.pyplot as plt
    plt.close(fig)
    return path


def data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


# --- The document ---


def build_report(runs: Sequence[ReportRun], base_motor: Dict, out_dir: Path,
                 title: Optional[str] = None,
                 figures_dir: Optional[Path] = None) -> ReportFiles:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    set_units(runs[0].spec if runs else None)
    staging_dir = tempfile.TemporaryDirectory(prefix="rocketopt-report-")
    staging = Path(staging_dir.name)
    # Figures are embedded in the page either way; a caller that wants them as
    # files too (outputs/ mirrors the last run) says where they should land.
    figures = make_figures(runs, base_motor,
                           Path(figures_dir) if figures_dir else staging / "figures")

    grain = base_motor["grains"][0]["properties"]
    nozzle = base_motor["nozzle"]
    baseline = simulate_motor(base_motor, timestep=0.002)
    title = title or _default_title(runs, base_motor)

    body = [_header(title, runs, base_motor, grain, baseline),
            _verdicts(runs),
            _fixed_section(runs, base_motor, grain, nozzle)]
    for index, run in enumerate(runs):
        body.append(_run_section(run, index, base_motor, figures))
    body.append(_footer(runs))

    document = "<title>{}</title>\n{}\n<style>{}</style>\n<div class=\"wrap\">{}</div>".format(
        esc(title), FONT_LINK, CSS, "\n".join(body))

    # Only the PDF is kept. Figures are embedded as data URIs, so the HTML and
    # the PNGs beside it are scaffolding once it has rendered.
    source = staging / "report.html"
    source.write_text(document)
    try:
        try:
            return ReportFiles(pdf=html_to_pdf(source, out_dir / "report.pdf"))
        except (NoBrowser, OSError, ValueError) as exc:
            # Nothing to render with, so the HTML *is* the report: keep it.
            fallback = out_dir / "report.html"
            fallback.write_text(document)
            return ReportFiles(html=fallback, pdf=None, pdf_error=str(exc))
    finally:
        staging_dir.cleanup()


def _default_title(runs: Sequence[ReportRun], base_motor: Dict) -> str:
    designs = [d for r in runs for d in r.designs]
    if designs:
        cls = "".join(c for c in designs[0].get("designation", "") if c.isalpha())[:1]
        if cls:
            return "{}-Class Trade Study".format(cls)
    bore = base_motor["grains"][0]["properties"]["diameter"]
    return "{}-{} Motor Study".format(dim(bore), "Inch" if _U.length == "in" else "mm")


def _header(title, runs, base_motor, grain, baseline) -> str:
    limits = runs[0].spec.enabled_constraints if runs else []
    brief = " / ".join("{} {} {:g}".format(
        metric_label(c.metric), c.op.replace("<=", "≤").replace(">=", "≥"),
        round(display(c.metric, c.value), 3)) for c in limits[:3])
    lede = ("Two optimisations of the same motor." if len(runs) > 1
            else "An optimisation of the motor as loaded.")
    if not any(r.feasible for r in runs):
        lede += (" No legal design exists under these limits. The section below explains why.")
    elif not all(r.feasible for r in runs):
        lede += (" One of them has no answer at all. The other produces a curve "
                 "of options.")
    else:
        lede += " The result is a trade-off rather than a single motor."
    return """<header>
  <p class="eyebrow">openMotor · {n} × BATES {d} × {l} {u} · {prop} · {brief}</p>
  <h1>{title}</h1>
  <p class="byline">Created by {author} · {date}</p>
  <p class="lede">{lede}</p>
</header>""".format(n=len(base_motor["grains"]), d=dim(grain["diameter"]),
                    l=dim(grain["length"]), u=_U.length,
                    prop=esc(base_motor["propellant"]["name"]),
                    brief=esc(brief), title=esc(title), lede=esc(lede),
                    author=AUTHOR, date=_today())


def _verdicts(runs: Sequence[ReportRun]) -> str:
    cards = []
    for run in runs:
        stats = run.result.get("stats", {})
        if run.feasible:
            designs = run.designs
            metrics = stats.get("objective_labels", ["initial_thrust"])
            spans = []
            for m in metrics[:2]:
                lo = min(display(m, d[m]) for d in designs)
                hi = max(display(m, d[m]) for d in designs)
                spans.append("{} {:,.0f}–{:,.0f} {}".format(
                    metric_label(m), lo, hi, metric_unit(m)))
            cards.append("""  <div class="verdict yes">
    <span class="tag">{n} designs</span>
    <span class="head">{label}</span>
    <p>{spans}. Every one legal on all limits, verified at a 0.002 s timestep.</p>
  </div>""".format(n=len(designs), label=esc(run.label),
                   spans=esc(". ".join(spans))))
        else:
            cards.append("""  <div class="verdict no">
    <span class="tag">no solution</span>
    <span class="head">{label}</span>
    <p>{sims:,} simulations, zero legal designs. Not a search failure — see below.</p>
  </div>""".format(label=esc(run.label), sims=stats.get("simulations", 0)))
    return '<div class="verdicts">\n{}\n</div>\n<hr class="rule">'.format("\n".join(cards))


def _fixed_section(runs, base_motor, grain, nozzle) -> str:
    spec = runs[0].spec
    n_loaded = len(base_motor["grains"])
    stack = sum(g["properties"]["length"] for g in base_motor["grains"])
    counted = any(r.spec.grain_count.free for r in runs)
    if counted:
        gc = spec.grain_count
        fixed = [("Stack length", "{} {} total, cut into {}–{} grains by the "
                  "search".format(dim(stack), _U.length, gc.n_min, gc.n_max)),
                 ("Grain outer diameter", dim(grain["diameter"]) + " " + _U.length)]
    else:
        fixed = [("Grain count", str(n_loaded)),
                 ("Grain outer diameter", dim(grain["diameter"]) + " " + _U.length),
                 ("Grain length", "{} {u} each · {} {u} total".format(
                     dim(grain["length"]), dim(stack), u=_U.length))]
    fixed += [("Inhibited ends", esc(grain.get("inhibitedEnds", "Neither"))),
             ("Propellant", esc(base_motor["propellant"]["name"])),
             ("Nozzle convergence / divergence", "{:.0f}° / {:.0f}°".format(
                 nozzle["convAngle"], nozzle["divAngle"])),
             ("Nozzle efficiency", "{:.3f}".format(nozzle["efficiency"]))]
    if nozzle.get("slagCoeff"):
        fixed.append(("Slag coefficient", "{:.3f} (m·Pa)/s".format(nozzle["slagCoeff"])))
    if nozzle.get("erosionCoeff"):
        fixed.append(("Throat erosion coefficient",
                      "{:.3e} m/(s·Pa)".format(nozzle["erosionCoeff"])))

    limits = [(metric_label(c.metric),
               "{} {:g} {}".format(c.op.replace("<=", "≤").replace(">=", "≥"),
                                   round(display(c.metric, c.value), 4),
                                   metric_unit(c.metric)))
              for c in spec.enabled_constraints]

    def describe(var):
        u = _U.length
        if not var.free:
            return "held at {} {}".format(dim_exact(
                var.fixed_value if var.fixed_value is not None else var.low), u)
        step = " · {} {} steps".format(dim(var.step), u) if var.step else " · any size"
        return "{} – {} {}{}".format(dim(var.low), dim(var.high), u, step)

    variables = [(name, describe(var))
                 for name, var in collapse(runs[0].spec.variables)]
    if counted:
        variables.insert(0, ("Grain count", "{} – {} grains, stack length held"
                             .format(spec.grain_count.n_min, spec.grain_count.n_max)))

    def dl(pairs):
        return '<dl class="spec">{}</dl>'.format("".join(
            "<dt>{}</dt><dd>{}</dd>".format(esc(k), v) for k, v in pairs))

    per_run = ""
    if len(runs) > 1:
        per_run = "".join(
            '<h3 style="margin-top:30px">{}: searched</h3>{}'.format(
                esc(r.label),
                dl([(name, describe(var)) for name, var in collapse(r.spec.variables)]))
            for r in runs)
    else:
        per_run = '<h3 style="margin-top:30px">Variables</h3>' + dl(variables)

    return """<section>
  <h2>What was held fixed</h2>
  <div class="prose"><p>Read from the motor file and carried through every run untouched.</p></div>
  {fixed}
  <h3 style="margin-top:30px">Limits</h3>
  {limits}
  {per_run}
  <div class="note steel">
    <span class="lbl">Two definitions</span>
    <p><strong>Initial thrust</strong> is the mean of the thrust curve over the first
    {win:.2f} s, excluding openMotor's zero-thrust sample at t = 0.
    <strong>Legal</strong> means the design was re-simulated at a {dt} s timestep with
    every search-time margin removed and cleared each limit on those numbers. Nothing
    here is a model prediction.</p>
  </div>
</section>
<hr class="rule">""".format(fixed=dl(fixed), limits=dl(limits), per_run=per_run,
                            win=_window(), dt=runs[0].spec.verify_timestep)


def _window() -> float:
    from .simulate import INITIAL_THRUST_WINDOW
    return INITIAL_THRUST_WINDOW


def _run_section(run: ReportRun, index: int, base_motor: Dict,
                 figures: Dict[str, Path]) -> str:
    key = "run{}".format(index)
    if not run.feasible:
        return _infeasible_section(run, key, base_motor, figures)
    return _feasible_section(run, key, base_motor, figures)


def _infeasible_section(run, key, base_motor, figures) -> str:
    info = diagnose(run, base_motor)
    sweep, closest, worst = info["sweep"], info["closest"], info["worst"]
    parts = ['<section><h2>{}: no answer</h2><div class="prose">'.format(esc(run.label))]

    if worst:
        parts.append("<p><strong>{}</strong> was the binding failure, at {:.0f}% of every "
                     "design tried broke it.</p>".format(
                         esc(worst["label"]), 100 * worst.get("violated_fraction", 0)))
    if closest:
        parts.append("<p>The closest any of {:,} simulated designs came was "
                     "{:.1f}% over.</p>".format(info["n_tried"],
                                                100 * closest.get("overshoot", 0)))
    parts.append("</div>")

    if sweep:
        parts.append("""<div class="eq">A(d) = {n}·[ π·d·L + (π/2)·(D² − d²) ]&nbsp;&nbsp;&nbsp;with D = {D:.2f} {u}, L = {L:.2f} {u}
dA/dd = {n}π·(L − d) &gt; 0 for every d &lt; {L:.2f} in</div>""".format(
            n=sweep["n_grains"], D=sweep["grain_diameter_in"], L=sweep["grain_length_in"],
            u=_U.length))
        parts.append("""<div class="prose" style="margin-top:22px">
  <p>With the throat held at {t} {u} its area is {a:.4f} {u}², so a Kn of {kn:.0f}
  caps burning area at <strong>{cap:.1f} {u}²</strong> at every instant of the burn.
  The derivative above is positive across the whole usable range, so the motor is
  progressive throughout — area only grows as the core opens, and Kn climbs from
  ignition to burnout. The smallest burning area available anywhere in the core range
  is {amin:.1f} {u}², giving a Kn of {knmin:.0f} <em>before the burn even starts</em>.</p>
  <p>No core diameter works. The throat has to grow.</p>
</div>""".format(t=("{:.4f}".format(sweep["throat_in"]).rstrip("0").rstrip(".")),
                 u=_U.length, a=sweep["throat_area_in2"],
                 kn=sweep["kn_limit"], cap=sweep["area_cap_in2"],
                 amin=sweep["area_min_in2"], knmin=sweep["kn_min"]))

    fig = figures.get(key + "_infeasible")
    if fig:
        parts.append("""<figure><img src="{src}" alt="Kn against core diameter with the
    throat held fixed, rising past the limit across the whole range.">
    <figcaption>Kn at ignition alone against core diameter. Anything above the dashed
    line is already illegal, and the burn only pushes it higher.</figcaption></figure>""".format(
            src=data_uri(fig)))

    if sweep:
        parts.append("""<div class="note"><span class="lbl">What it would take</span>
    <p>To hold Kn at {kn:.0f} even at the smallest achievable burning area, the throat
    would need to be at least <strong>{need:.2f} {u}</strong> — about
    <strong>{short:.2f} {u}</strong> wider than the one in the file. That single dimension
    is what stands between this motor and a legal one.</p></div>""".format(
            kn=sweep["kn_limit"], need=sweep["min_throat_in"], u=_U.length,
            short=sweep["min_throat_in"] - sweep["throat_in"]))
    if run.spec.grain_count.free:
        parts.append(_counts_section(run))
    parts.append('</section><hr class="rule">')
    return "\n".join(parts)


def _feasible_section(run, key, base_motor, figures) -> str:
    designs = run.designs
    options = pick_options(designs)
    metrics = run.result.get("stats", {}).get("objective_labels", ["initial_thrust"])
    pick = balanced_index(options, metrics)

    counts = sorted({int(o.get("n_grains", 0) or 0) for o in options})
    counted = len(counts) > 1 or run.spec.grain_count.free
    head = ["#", "Class"] + (["Grains"] if counted else [])
    head += ["{}<span>{}</span>".format(metric_label(m), metric_unit(m)) for m in metrics]
    head += ["ISP<span>s</span>", "Burn<span>s</span>", "Propellant<span>kg</span>",
             "Peak<span>{}</span>".format(_U.pressure), "Peak<span>Kn</span>",
             "Flux<span>{}</span>".format(_U.flux)]
    rows = []
    for i, o in enumerate(options, 1):
        cells = ['<td class="idx">{}</td>'.format(i),
                 '<td class="des">{}</td>'.format(esc(o.get("designation", "")))]
        if counted:
            cells.append('<td class="n">{}</td>'.format(o.get("n_grains", "")))
        for j, m in enumerate(metrics):
            cls = "n strong" if j == 0 else "n"
            cells.append('<td class="{}">{:,.{}f}</td>'.format(
                cls, display(m, o[m]), metric_places(m)))
        cells += ['<td class="n">{:.1f}</td>'.format(o["isp"]),
                  '<td class="n">{:.2f}</td>'.format(o["burn_time"]),
                  '<td class="n">{:.2f}</td>'.format(o["prop_mass"]),
                  '<td class="n">{:.{}f}</td>'.format(
                      display("max_pressure", o["max_pressure"]), _U.pressure_places),
                  '<td class="n">{:.0f}</td>'.format(o["peak_kn"]),
                  '<td class="n">{:.{}f}</td>'.format(
                      display("peak_mass_flux", o["peak_mass_flux"]), _U.flux_places)]
        rows.append('<tr{}>{}</tr>'.format(' class="pick"' if i - 1 == pick else "",
                                           "".join(cells)))

    geom = []
    for i, o in enumerate(options, 1):
        geom.append('<tr{hi}><td class="idx">{i}</td><td class="mono cores">{c}</td>'
                    '<td class="n">{t}</td><td class="n">{e}</td><td class="n">{tl}</td>'
                    '<td class="n">{x:.2f}</td><td class="n">{pt:.2f}</td></tr>'.format(
                        hi=' class="pick"' if i - 1 == pick else "", i=i,
                        c=" · ".join(dim(c) for c in o["cores"]),
                        t=dim(o["throat"]), e=dim(o["exit"]),
                        tl=dim(o.get("throat_length", 0.0)),
                        x=(o["exit"] / o["throat"]) ** 2, pt=o["port_throat"]))

    best = options[pick]
    detail = [("Designation", esc(best.get("designation", "")))]
    if counted:
        lengths = best.get("grain_lengths") or []
        detail.append(("Grains", "{} × {} {}".format(
            best.get("n_grains", len(best["cores"])),
            dim(lengths[0]) if lengths else "?", _U.length)))
    detail += [("Core diameters", " · ".join(dim(c) for c in best["cores"]) + " " + _U.length),
              ("Throat / exit / length", "{} / {} / {} {}".format(
                  dim(best["throat"]), dim(best["exit"]),
                  dim(best.get("throat_length", 0.0)), _U.length))]
    for m in metrics:
        detail.append((metric_label(m), "{:,.{}f} {}".format(
            display(m, best[m]), metric_places(m), metric_unit(m))))
    detail += [("Specific impulse", "{:.1f} s".format(best["isp"])),
               ("Burn time", "{:.2f} s".format(best["burn_time"])),
               ("Propellant mass", "{:.2f} kg".format(best["prop_mass"]))]

    front_fig = figures.get(key + "_front")
    curve_fig = figures.get(key + "_curves")
    return """<section>
  <h2>{label}: {n} legal motors</h2>
  <div class="prose"><p>The objectives pull against one another across the whole set, so
  the result is a curve rather than a single winner. Row {pick} is the balanced choice,
  conceding the least on any one objective.</p></div>
  {front}
  <div class="scroll"><table>
    <caption>{n2} options spread along the curve, rather than the top {n2}, which would
    be variations on a single motor.</caption>
    <thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>
  <div class="scroll"><table>
    <caption>Geometry for the same options. Cores run forward to aft.</caption>
    <thead><tr><th class="n">#</th><th>Core diameters ({u})</th>
    <th class="n">Throat<span>{u}</span></th><th class="n">Exit<span>{u}</span></th>
    <th class="n">Throat len<span>{u}</span></th><th class="n">Expansion</th>
    <th class="n">Port/throat</th></tr></thead><tbody>{geom}</tbody></table></div>
  {curves}
  <h3 style="margin-top:34px">The balanced pick</h3>
  <dl class="spec">{detail}</dl>
  {counts}
</section>
<hr class="rule">""".format(
        label=esc(run.label), n=len(designs), n2=len(options), pick=pick + 1,
        head="".join("<th class=\"n\">{}</th>".format(h) if h != "Class" else "<th>Class</th>"
                     for h in head),
        rows="".join(rows), geom="".join(geom), u=_U.length,
        counts=_counts_section(run) if counted else "",
        front='<figure><img src="{}" alt="Trade-off curve of the legal designs."><figcaption>'
              'Every legal design found, with the tabulated options marked.</figcaption></figure>'.format(
                  data_uri(front_fig)) if front_fig else "",
        curves='<figure><img src="{}" alt="Thrust curves for the tabulated options.">'
               '<figcaption>The same options as thrust curves.</figcaption></figure>'.format(
                   data_uri(curve_fig)) if curve_fig else "",
        detail="".join("<dt>{}</dt><dd>{}</dd>".format(esc(k), v) for k, v in detail))


def _counts_section(run: ReportRun) -> str:
    """How each grain count fared: screened out, tried briefly, or searched.

    The stack length was held and cut into every count in the range, so this
    is the same propellant column with more or fewer end faces.
    """
    info = run.result.get("stats", {}).get("grain_counts") or {}
    stacks = info.get("stacks") or []
    if not stacks:
        return ""
    multi = len(run.result.get("stats", {}).get("objective_labels", [])) > 1
    rows = []
    for st in stacks:
        s1 = st.get("stage1") or {}
        if st.get("dropped"):
            outcome, score = "screened out", "—"
            note = st["dropped"]
        else:
            if s1.get("score") is not None:
                score = "{:.3f}".format(s1["score"])
            elif s1.get("near") is not None:
                score = "no legal design"
            else:
                score = "—"
            if st.get("carried"):
                outcome = "searched in full"
                note = "{} legal design{}".format(
                    st.get("designs", 0), "" if st.get("designs", 0) == 1 else "s")
            else:
                outcome = "tried, not carried"
                note = ("ranked {} of {} after {} generations".format(
                    s1.get("rank"), len([x for x in stacks if not x.get("dropped")]),
                    info.get("stage_generations", "")) if s1.get("rank") else "")
        rows.append(
            '<tr{hi}><td class="idx">{n}</td><td class="n">{l}</td>'
            '<td class="{cls}">{outcome}</td><td class="n">{score}</td>'
            '<td class="des">{note}</td><td class="n">{sims:,}</td></tr>'.format(
                hi=' class="pick"' if st.get("carried") else "", n=st["n"],
                l=dim(st.get("grain_length", 0.0)),
                cls="strong" if st.get("carried") else "des",
                outcome=outcome, score=score, note=esc(note),
                sims=int(st.get("simulations", 0))))
    metric = "hypervolume of its front" if multi else "best legal score"
    return """<h3 style="margin-top:34px">Grain counts</h3>
  <div class="prose"><p>The {stack} stack was cut into each count below. Every count
  was checked on paper first, then given {gens} generations; the best {carry} went on to
  the full search. Score is the {metric} after those {gens} generations, on the same
  axes for every count.</p></div>
  <div class="scroll"><table>
    <thead><tr><th class="n">Grains</th><th class="n">Length<span>{u} each</span></th>
    <th>Outcome</th><th class="n">Score</th><th>Why</th>
    <th class="n">Simulations</th></tr></thead><tbody>{rows}</tbody></table></div>""".format(
        stack=dim(info.get("stack_length", 0.0)) + " " + _U.length, u=_U.length,
        gens=info.get("stage_generations", ""), carry=len(info.get("carried", [])),
        metric=metric, rows="".join(rows))


def _footer(runs: Sequence[ReportRun]) -> str:
    total = sum(r.result.get("stats", {}).get("simulations", 0) for r in runs)
    modes = ", ".join(sorted({r.result.get("stats", {}).get("mode", "") for r in runs}))
    seeds = max((r.result.get("stats", {}).get("seeds", 1) or 1) for r in runs)
    merge = ("" if seeds < 2 else
             " · each optimisation ran {} independent searches and reported the "
             "non-dominated set of everything they found".format(seeds))
    return """<footer>
  openMotor 0.6.2 (GPLv3, vendored unmodified) · {total:,} simulations across
  {n} optimisation{s} · mode: {modes} · verification timestep {dt} s{merge}<br>
  Every figure and table was derived from designs re-simulated in openMotor, not from
  model output.<br>
  Lior&#8217;s Really Good&#8482; Rocket Optimizer · created by {author}
</footer>""".replace("{author}", AUTHOR).format(total=total, n=len(runs), s="" if len(runs) == 1 else "s",
                    modes=esc(modes), dt=runs[0].spec.verify_timestep, merge=merge)
