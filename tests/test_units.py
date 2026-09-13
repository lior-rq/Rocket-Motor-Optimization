"""The report follows the unit system the run was configured in."""
import sys
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt import report as rep
from rocketopt.pdf import NoBrowser
from rocketopt.ric import load_ric
from rocketopt.runner import build_space, default_spec, describe_design
from tests import sample_motor

MOTOR = sample_motor.path(ROOT)


@pytest.fixture(scope="module")
def base():
    return load_ric(MOTOR)


@pytest.fixture(scope="module")
def run(base):
    """A one-design result, described for real so every field is present."""
    spec = default_spec(base)
    space = build_space(spec, base)
    design = describe_design(space, space.from_motor(base), spec, "Option 1")
    baseline = dict(design, label="Your motor")
    result = {"designs": [design], "baseline": baseline,
              "stats": {"objective_labels": ["initial_thrust", "total_impulse"],
                        "simulations": 1, "seeds": 1, "mode": "fast"},
              "population": [], "constraint_activity": []}
    return spec, result


def _html(run, tmp_path, units):
    spec, result = run
    spec.display_units = units
    with mock.patch.object(rep, "html_to_pdf", side_effect=NoBrowser("none")):
        files = rep.build_report([rep.ReportRun("t", result, spec)], load_ric(MOTOR),
                                 tmp_path)
    return files.html.read_text()


def test_units_context_swaps_length_pressure_and_flux():
    rep.set_units(None)
    assert rep.dim(0.0254) == "1.00" and rep.metric_unit("max_pressure") == "psi"
    spec = default_spec(load_ric(MOTOR))
    spec.display_units = {"length": "mm", "pressure": "MPa", "mass_flux": "kg/(m^2*s)"}
    rep.set_units(spec)
    assert rep.dim(0.0254) == "25.4"
    assert rep.metric_unit("max_pressure") == "MPa"
    assert rep.metric_unit("peak_mass_flux") == "kg/m²s"
    assert rep.display("max_pressure", 3.0e6) == pytest.approx(3.0)
    rep.set_units(None)


def test_metric_report_carries_no_inches(run, tmp_path):
    html = _html(run, tmp_path / "mm", {"length": "mm", "pressure": "MPa",
                                        "mass_flux": "kg/(m^2*s)"})
    assert "MPa" in html and " mm" in html
    assert "psi" not in html
    assert "<span>in</span>" not in html and " in each" not in html


def test_imperial_report_is_unchanged(run, tmp_path):
    html = _html(run, tmp_path / "in", {"length": "in", "pressure": "psi",
                                        "mass_flux": "lb/(in^2*s)"})
    assert "psi" in html and " in each" in html
    assert "MPa" not in html


def test_peak_core_mach_is_measured_and_limited(base):
    """openMotor only warns past Mach 1; the search holds it as a constraint."""
    from rocketopt.optimize import Objective, scale_constraints
    from rocketopt.simulate import curves, simulate_motor
    from rocketopt.spec import ConstraintSpec
    import pandas as pd

    metrics = simulate_motor(base, timestep=0.01)
    assert metrics.ok and 0.0 < metrics.peak_mach < 1.0
    trace = curves(base, timestep=0.01)
    assert len(trace["mach"]) == len(base["grains"])
    assert max(max(row) for row in trace["mach"]) == pytest.approx(metrics.peak_mach, rel=0.05)

    frame = pd.DataFrame([dict(metrics.as_row())])
    tight = Objective(constraints=(ConstraintSpec(metric="peak_mach", op="<=",
                                                  value=metrics.peak_mach / 2),))
    loose = Objective(constraints=(ConstraintSpec(metric="peak_mach", op="<=", value=1.0),))
    assert scale_constraints(frame, tight, None)[0, 0] > 0
    assert scale_constraints(frame, loose, None)[0, 0] < 0
    assert any(c.metric == "peak_mach" and c.enabled for c in default_spec(base).constraints)


def test_residual_propellant_is_measured_and_limited(base):
    """What is left at burnout, as a share of the load; a limit like any other."""
    from rocketopt.optimize import Objective, scale_constraints
    from rocketopt.simulate import simulate_motor
    from rocketopt.spec import ConstraintSpec
    import pandas as pd

    metrics = simulate_motor(base, timestep=0.01)
    assert metrics.ok and 0.0 <= metrics.residual_pct < 5.0
    frame = pd.DataFrame([dict(metrics.as_row())])
    tight = Objective(constraints=(ConstraintSpec(metric="residual_pct", op="<=",
                                                  value=metrics.residual_pct / 2),))
    loose = Objective(constraints=(ConstraintSpec(metric="residual_pct", op="<=",
                                                  value=5.0),))
    assert scale_constraints(frame, tight, None)[0, 0] > 0
    assert scale_constraints(frame, loose, None)[0, 0] < 0
    offered = [c for c in default_spec(base).constraints if c.metric == "residual_pct"]
    assert offered and not offered[0].enabled
