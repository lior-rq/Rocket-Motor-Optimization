"""Speed off the rail: the integration, the metric, and the plumbing that
carries the rocket's mass into every burn."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt.rail import G, max_hardware_mass, rail_exit_velocity
from rocketopt.ric import load_ric
from rocketopt.runner import build_space, default_spec, describe_design
from rocketopt.simulate import simulate_motor
from rocketopt.spec import RailSpec, RunSpec
from tests import sample_motor

MOTOR = sample_motor.path(ROOT)
RAIL = 25 * 0.3048


@pytest.fixture(scope="module")
def base():
    return load_ric(MOTOR)


def _constant(force: float, seconds: float = 3.0, dt: float = 0.01):
    t = np.arange(0.0, seconds + dt / 2, dt)
    return t, np.full_like(t, force)


def test_constant_thrust_matches_the_closed_form():
    t, f = _constant(400.0)
    a = 400.0 / 10.0 - G * math.cos(math.radians(7.0))
    assert rail_exit_velocity(t, f, 10.0, RAIL) == pytest.approx(math.sqrt(2 * a * RAIL))
    assert rail_exit_velocity(t, f, 10.0, 0.5) == pytest.approx(math.sqrt(2 * a * 0.5))


def test_thrust_under_weight_never_leaves_the_pad():
    t, f = _constant(50.0)
    assert rail_exit_velocity(t, f, 10.0, RAIL) == 0.0


def test_burnout_before_the_top_coasts_the_rest():
    t, f = _constant(400.0, seconds=0.6)
    g = G * math.cos(math.radians(7.0))
    a = 400.0 / 10.0 - g
    v, x = a * 0.6, 0.5 * a * 0.36
    assert rail_exit_velocity(t, f, 10.0, RAIL) == pytest.approx(
        math.sqrt(v ** 2 - 2 * g * (RAIL - x)))
    # Too little burn and it never gets there.
    t, f = _constant(400.0, seconds=0.2)
    assert rail_exit_velocity(t, f, 10.0, RAIL) == 0.0


def test_exit_speed_falls_with_mass():
    t, f = _constant(400.0)
    speeds = [rail_exit_velocity(t, f, m, RAIL) for m in (5.0, 10.0, 15.0)]
    assert speeds == sorted(speeds, reverse=True)


def test_max_hardware_mass_inverts_the_speed():
    t, f = _constant(400.0)
    heaviest = max_hardware_mass(t, f, 2.0, 25.0, RAIL)
    assert rail_exit_velocity(t, f, heaviest + 2.0, RAIL) == pytest.approx(25.0, abs=1e-6)
    assert rail_exit_velocity(t, f, heaviest + 2.5, RAIL) < 25.0
    t, f = _constant(50.0)
    assert math.isnan(max_hardware_mass(t, f, 2.0, 25.0, RAIL))


def test_metric_is_measured_only_when_a_rocket_is_given(base):
    plain = simulate_motor(base, timestep=0.01)
    assert plain.ok and math.isnan(plain.rail_velocity)
    flown = simulate_motor(base, timestep=0.01, rail=RailSpec(hardware_mass=8.0))
    assert flown.ok and flown.rail_velocity > 0.0
    heavier = simulate_motor(base, timestep=0.01, rail=RailSpec(hardware_mass=16.0))
    assert heavier.rail_velocity < flown.rail_velocity
    # Search and verification fidelity agree closely: the bias is near unity.
    fine = simulate_motor(base, timestep=0.002, rail=RailSpec(hardware_mass=8.0))
    assert fine.rail_velocity == pytest.approx(flown.rail_velocity, rel=0.01)


def test_spec_round_trips_the_rail(base):
    spec = default_spec(base)
    row = next(c for c in spec.constraints if c.metric == "rail_velocity")
    assert not row.enabled and row.op == ">=" and row.value == 25.0
    assert spec.rail.hardware_mass is None and spec.rail.length == pytest.approx(RAIL)
    spec.rail = RailSpec(hardware_mass=9.5, length=5.0, angle_deg=5.0)
    again = RunSpec.from_dict(spec.to_dict())
    assert again.rail == spec.rail
    # A saved spec from before the rail existed still loads.
    old = spec.to_dict()
    del old["rail"]
    assert RunSpec.from_dict(old).rail == RailSpec()


def test_the_rail_reaches_the_workers_and_the_designs(base):
    spec = default_spec(base)
    spec.rail = RailSpec(hardware_mass=8.0)
    next(c for c in spec.constraints if c.metric == "rail_velocity").enabled = True
    assert spec.problems() == []
    space = build_space(spec, base)
    assert space.worker_spec()[1]["rail"] == spec.rail
    design = describe_design(space, space.from_motor(base), spec, "Option 1")
    assert design["rail_velocity"] > 0.0


def test_report_states_the_rocket_behind_the_limit(base, tmp_path):
    from unittest import mock
    from rocketopt import report as rep
    from rocketopt.pdf import NoBrowser

    spec = default_spec(base)
    spec.rail = RailSpec(hardware_mass=9.0)
    next(c for c in spec.constraints if c.metric == "rail_velocity").enabled = True
    space = build_space(spec, base)
    design = describe_design(space, space.from_motor(base), spec, "Option 1")
    result = {"designs": [design], "baseline": dict(design, label="Your motor"),
              "stats": {"objective_labels": ["initial_thrust", "total_impulse"],
                        "simulations": 1, "seeds": 1, "mode": "fast"},
              "population": [], "constraint_activity": []}
    with mock.patch.object(rep, "html_to_pdf", side_effect=NoBrowser("none")):
        files = rep.build_report([rep.ReportRun("t", result, spec)], base, tmp_path)
    html = files.html.read_text()
    assert "Rail exit speed" in html and "≥ 25 m/s" in html
    assert "19.84 lb of hardware on a 25.0 ft rail, 7° from vertical" in html
