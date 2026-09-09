"""Each problem names the part of the configuration that can fix it.

The wizard gates a step on its own problems only. Without the tag a missing
objective value blocked the constraints step, which is the page it cannot be
fixed from.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt.ric import load_ric
from rocketopt.runner import default_spec
from tests import sample_motor

MOTOR = sample_motor.path(ROOT)


def build():
    return default_spec(load_ric(MOTOR))


def areas(spec, text):
    return [area for area, message in spec.problems() if text in message]


def test_clean_spec_has_no_problems():
    assert build().problems() == []


def test_missing_target_belongs_to_the_objectives():
    spec = build()
    spec.objectives[0].direction = "target"
    spec.objectives[0].target = None
    assert areas(spec, "needs a target value") == ["objectives"]


def test_no_free_dimension_belongs_to_the_variables():
    spec = build()
    for var in spec.variables:
        var.free = False
    assert areas(spec, "free to change") == ["variables"]


def test_bad_bounds_belong_to_the_variables():
    spec = build()
    var = next(v for v in spec.variables if v.free)
    var.high = var.low
    assert areas(spec, "upper bound") == ["variables"]


def test_unknown_constraint_belongs_to_the_constraints():
    spec = build()
    spec.constraints[0].enabled = True
    spec.constraints[0].metric = "nonsense"
    assert areas(spec, "Unknown constraint") == ["constraints"]


def test_validate_still_returns_plain_strings():
    spec = build()
    spec.objectives[0].direction = "target"
    spec.objectives[0].target = None
    assert spec.validate() == [m for _, m in spec.problems()]
    assert all(isinstance(p, str) for p in spec.validate())
