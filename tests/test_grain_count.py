"""Searching the grain count: the stack cut into each count in a range.

The guarantee is that every count is the same propellant column, that each
count's search is the fixed-count search unchanged, and that what comes back
across counts is ranked and reported on metrics alone.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt.optimize import Objective
from rocketopt.ric import load_ric
from rocketopt.runner import (_Stack, _merge_designs, _screen, _select,
                              build_space, default_spec, grain_counts,
                              motor_for, run, stack_motor)
from rocketopt.sizing import size_space
from rocketopt.spec import (GrainCountSpec, ObjectiveSpec,
                            OrderingSpec, RunSpec, core_specs)
from tests import sample_motor

IN = 0.0254
MOTOR = sample_motor.path(ROOT)


@pytest.fixture(scope="module")
def base():
    return load_ric(MOTOR)


@pytest.fixture
def spec(base):
    s = default_spec(base)
    s.grain_count = GrainCountSpec(free=True, n_min=4, n_max=8)
    return s


# --- the stack ---------------------------------------------------------------


def test_stack_motor_holds_total_length(base):
    total = sum(g["properties"]["length"] for g in base["grains"])
    for n in (4, 6, 8):
        motor = stack_motor(base, n)
        grains = motor["grains"]
        assert len(grains) == n
        lengths = [g["properties"]["length"] for g in grains]
        assert lengths == pytest.approx([total / n] * n)
        assert all(g["type"] == "BATES" for g in grains)
        assert len({g["properties"]["diameter"] for g in grains}) == 1


def test_grain_counts_follow_the_rule(base, spec):
    assert grain_counts(spec, base) == [4, 5, 6, 7, 8]
    spec.grain_count.free = False
    assert grain_counts(spec, base) == [len(base["grains"])]


# --- the space per count -----------------------------------------------------


def test_space_at_another_count(base, spec):
    for n in (4, 8):
        space = build_space(spec, base, n)
        assert space.n_grains == n
        assert space.names[:n] == ["core_{}".format(i + 1) for i in range(n)]
        motor = space.to_motor(space.lower)
        assert len(motor["grains"]) == n
        lengths = [g["properties"]["length"] for g in motor["grains"]]
        assert len({round(v, 12) for v in lengths}) == 1


def test_fixed_count_leaves_the_file_alone(base):
    spec = default_spec(base)
    space = build_space(spec, base)
    assert space.n_grains == len(base["grains"])
    assert list(space.grain_lengths) == pytest.approx(
        [g["properties"]["length"] for g in base["grains"]])


def test_core_specs_pad_and_free(base, spec):
    spec.variables[2].free = False           # pin grain 3
    specs = core_specs(spec, 8)
    assert [v.name for v in specs] == ["core_{}".format(i + 1) for i in range(8)]
    assert all(v.free for v in specs), "a free count frees every core"
    assert specs[7].low == specs[0].low and specs[7].step == specs[0].step
    spec.grain_count.free = False
    assert not core_specs(spec, 6)[2].free, "a fixed count keeps the pin"


def test_motor_for_prefers_the_carried_motor(base, spec):
    space = build_space(spec, base, 5)
    x = space.lower
    built = space.to_motor(x)
    assert motor_for({"x": list(x), "motor": built}, space) == built
    assert len(motor_for({"x": list(x)}, space)["grains"]) == 5
    assert motor_for({"x": list(x), "motor": built}, space) is not built


# --- the spec ----------------------------------------------------------------


def test_spec_round_trips_and_validates(base, spec):
    again = RunSpec.from_dict(spec.to_dict())
    assert again.grain_count == spec.grain_count
    spec.grain_count.n_max = 3
    assert any("maximum" in m for m in spec.validate())
    spec.grain_count.n_max = 8
    spec.ordering = OrderingSpec(mode="paired", groups=(3, 3))
    assert any("Mandrel" in m for m in spec.validate())


def test_sizing_at_a_count_above_the_loaded_one(base, spec):
    small = size_space(spec, 4)
    large = size_space(spec, 8)
    assert small["total"] and large["total"]
    assert large["total"] > small["total"]


# --- screening ---------------------------------------------------------------


def test_screen_drops_a_count_no_limit_allows(base, spec):
    objective = Objective()
    space = build_space(spec, base, 8)
    stack = _Stack(n=8, space=space, objective=objective,
                   seeds=space.lower[None, :], grain_length=0.1)
    assert _screen(stack, spec) is None
    tight = RunSpec.from_dict(spec.to_dict())
    for c in tight.constraints:
        if c.metric == "peak_kn":
            c.value = 5.0                    # nothing burns this slowly
    assert _screen(stack, tight) is not None


# --- choosing what goes on ---------------------------------------------------


def _stack(n, score=None, near=None):
    space = None
    stack = _Stack(n=n, space=space, objective=Objective(), seeds=np.zeros((1, 1)),
                   grain_length=0.1)
    stack.stage1 = {"score": score, "near": near, "simulations": 0}
    return stack


def test_select_carries_the_best_and_anything_close():
    spec = RunSpec(grain_count=GrainCountSpec(free=True, carry=2, carry_within=0.10))
    stacks = [_stack(4, 1.00), _stack(5, 0.95), _stack(6, 0.92), _stack(7, 0.50),
              _stack(8, None, near=-0.2)]
    _select(stacks, spec)
    carried = [s.n for s in stacks if s.carried]
    assert carried == [4, 5, 6], "top two plus the one within 10%"
    assert [s.stage1["rank"] for s in stacks] == [1, 2, 3, 4, 5]


def test_select_ranks_the_closest_when_nothing_is_legal():
    spec = RunSpec(grain_count=GrainCountSpec(free=True, carry=1))
    stacks = [_stack(4, None, near=-0.5), _stack(5, None, near=-0.1),
              _stack(6, None, near=-0.3)]
    _select(stacks, spec)
    assert [s.n for s in stacks if s.carried] == [5]


# --- merging across counts ---------------------------------------------------


def _design(n, thrust, impulse):
    row = {"n_grains": n, "initial_thrust": thrust, "total_impulse": impulse,
           "label": "x"}
    for m in ("peak_thrust", "avg_thrust", "isp", "burn_time", "thrust_variation",
              "max_pressure", "avg_pressure", "peak_kn", "initial_kn",
              "peak_mass_flux", "port_throat", "prop_mass", "volume_loading",
              "separation_pct"):
        row[m] = 1.0
    return row


def test_merge_takes_the_front_across_counts():
    objective = Objective(
        objectives=(ObjectiveSpec(metric="initial_thrust"),
                    ObjectiveSpec(metric="total_impulse")),
        baselines={"initial_thrust": 1000.0, "total_impulse": 5000.0})
    a = _stack(5); a.designs = [_design(5, 1200, 5000), _design(5, 900, 5600)]
    b = _stack(7); b.designs = [_design(7, 1300, 5100), _design(7, 800, 5200)]
    merged = _merge_designs([a, b], objective, n_obj=2)
    kept = {(d["n_grains"], d["initial_thrust"]) for d in merged}
    assert (7, 1300) in kept and (5, 900) in kept
    assert (5, 1200) not in kept, "dominated by the 7-grain motor"
    assert (7, 800) not in kept
    assert [d["label"] for d in merged] == ["Option 1", "Option 2"]


def test_merge_drops_the_same_motor_found_twice():
    objective = Objective(objectives=(ObjectiveSpec(metric="total_impulse"),),
                          baselines={"total_impulse": 5000.0})
    a = _stack(5)
    twice = dict(_design(5, 1000, 5000), x=[0.02, 0.03, 0.01, 0.5])
    a.designs = [twice, dict(twice), dict(_design(5, 900, 4000), x=[0.02, 0.03, 0.011, 0.5])]
    assert len(_merge_designs([a], objective, n_obj=1)) == 2


# --- the whole thing, small --------------------------------------------------


def test_run_searches_two_counts_and_reports_each(base):
    spec = default_spec(base)
    spec.grain_count = GrainCountSpec(free=True, n_min=5, n_max=6,
                                      stage_generations=2, carry=1)
    spec.expert = True
    spec.budget_simulations = 160
    spec.seeds = 1
    for v in spec.variables:
        if v.name == "throat_length":
            v.free = False
    snaps = []
    result = run(spec, base, workers=1, on_telemetry=snaps.append)

    info = result.stats["grain_counts"]
    assert info["counts"] == [5, 6]
    assert len(info["carried"]) == 1
    assert {s["n"] for s in info["stacks"]} == {5, 6}
    assert all(s["stage1"] for s in info["stacks"])
    assert result.stats["searched"][0] == "n_grains"
    assert any(s.get("stage") == "stage1" for s in snaps)
    assert all("simulations_total" in s for s in snaps)
    # Every generation names its best legal motor, so a run can hand it out
    # before it finishes.
    leaders = [s for s in snaps if s.get("leader")]
    assert leaders
    for s in leaders:
        n = s["n_grains"]
        assert len(s["leader"]["x"]) == build_space(spec, base, n).n_dim
        assert s["leader"]["metric"] == result.stats["objective_labels"][0]
    for design in result.designs:
        assert design["n_grains"] in (5, 6)
        assert len(design["motor"]["grains"]) == design["n_grains"]
        assert len(design["cores"]) == design["n_grains"]
