"""RASP .eng output.

The format is read by other people's software, so the checks here are the ones
OpenRocket and RockSim actually enforce: a seven-field header with no embedded
whitespace, a strictly rising time column that starts after zero, positive
thrust throughout the burn, and a final zero.
"""
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt.eng import (CURVE_POINTS, design_eng, eng_text, resample,
                           build_eng_file)
from rocketopt.outputs import build_ric_bundle
from rocketopt.ric import load_ric
from rocketopt.runner import build_space, default_spec, describe_design
from rocketopt.simulate import curves, simulate_motor
from tests import sample_motor

MOTOR = sample_motor.path(ROOT)


def parse(text):
    """(header fields, [(time, thrust)]) from one .eng file."""
    lines = [l for l in text.splitlines() if l.strip() and not l.startswith(";")]
    head = lines[0].split()
    rows = [tuple(map(float, l.split())) for l in lines[1:]]
    return head, rows


def parse_many(text):
    """Every motor in a file, the way OpenRocket reads one: a comment line
    ends the data of the motor before it."""
    motors, block = [], []
    for line in text.splitlines():
        if line.startswith(";"):
            if block:
                motors.append(parse("\n".join(block)))
                block = []
        elif line.strip():
            block.append(line)
    if block:
        motors.append(parse("\n".join(block)))
    return motors


def assert_valid(text):
    head, rows = parse(text)
    assert len(head) == 7, "header has {} fields: {!r}".format(len(head), head)
    for field in head:
        assert " " not in field
    float(head[1]); float(head[2]); float(head[4]); float(head[5])
    assert len(rows) >= 3
    assert rows[0][0] > 0, "first sample must be after ignition"
    assert all(b[0] > a[0] for a, b in zip(rows, rows[1:])), "time must rise"
    assert rows[-1][1] == 0.0, "the curve has to end at zero thrust"
    assert all(r[1] > 0 for r in rows[:-1]), "no zero thrust mid-burn"
    return head, rows


def test_resample_produces_a_legal_curve():
    time = np.linspace(0, 5, 900)
    thrust = 6000 * np.exp(-time / 4)
    thrust[-40:] = 0.0                      # a tail of burnout samples
    rows = resample(time.tolist(), thrust.tolist())
    assert len(rows) <= CURVE_POINTS + 20
    assert rows[0][0] > 0
    assert rows[-1][1] == 0.0
    assert all(b[0] > a[0] for a, b in zip(rows, rows[1:]))


def test_resample_keeps_the_peak():
    time = np.linspace(0, 4, 800)
    thrust = np.full_like(time, 1000.0)
    thrust[400] = 5000.0                    # one narrow spike
    rows = resample(time.tolist(), thrust.tolist())
    assert max(r[1] for r in rows) == pytest.approx(5000.0)


def test_resample_refuses_a_curve_with_no_thrust():
    assert resample([0, 1, 2], [0, 0, 0]) == []


def test_eng_text_header_is_seven_fields():
    rows = [[0.05, 100.0], [1.0, 90.0], [1.1, 0.0]]
    head, back = assert_valid(
        eng_text("K550-01", rows, 54.0, 410.0, 0.919))
    assert head[0] == "K550-01"
    assert head[3] == "P"
    # Propellant and total are the same figure: no casing is modelled.
    assert head[4] == head[5]


def test_eng_says_the_total_mass_excludes_hardware():
    text = eng_text("X-01", [[0.1, 10.0], [0.2, 0.0]], 54.0, 410.0, 0.5)
    comments = " ".join(l for l in text.splitlines() if l.startswith(";")).lower()
    assert "casing" in comments and "not modelled" in comments


def test_design_eng_from_a_real_simulation():
    motor = load_ric(MOTOR)
    design = {"designation": "1234J567", "x": []}
    measured = curves(motor, timestep=0.002)
    measured["prop_mass"] = float(simulate_motor(motor, timestep=0.002).prop_mass)
    text = design_eng(design, 0, motor, measured)
    head, rows = assert_valid(text)

    assert head[0] == "1234J567-01"
    grains = motor["grains"]
    assert float(head[1]) == pytest.approx(
        grains[0]["properties"]["diameter"] * 1000.0, rel=1e-6)
    assert float(head[2]) == pytest.approx(
        sum(g["properties"]["length"] for g in grains) * 1000.0, rel=1e-6)

    # The tabulated curve has to carry the impulse the simulator reported.
    metrics = simulate_motor(motor, timestep=0.002)
    # Spelled out rather than np.trapz/np.trapezoid, which numpy renamed
    # between 1 and 2 and which this suite has to run under both.
    integrated = sum((a[1] + b[1]) / 2 * (b[0] - a[0])
                     for a, b in zip(rows, rows[1:]))
    assert integrated == pytest.approx(metrics.total_impulse, rel=0.02)


def test_design_eng_returns_none_without_a_curve():
    motor = load_ric(MOTOR)
    assert design_eng({"designation": "X"}, 0, motor, {"time": [], "thrust": []}) is None


def test_bundle_refuses_an_empty_front(tmp_path):
    with pytest.raises(ValueError):
        build_eng_file([], None, load_ric(MOTOR), tmp_path / "out.eng")
    with pytest.raises(ValueError):
        build_ric_bundle([], None, tmp_path / "out.zip")


def _two_designs():
    base = load_ric(MOTOR)
    spec = default_spec(base)
    space = build_space(spec, base)
    x = space.from_motor(base)
    y = x.copy()
    y[space.names.index("throat")] *= 1.1
    y = space.canonical_one(y)
    return base, space, [describe_design(space, x, spec, "Option 1"),
                         describe_design(space, y, spec, "Option 2")]


def test_one_eng_file_lists_every_motor(tmp_path):
    base, space, designs = _two_designs()
    path = build_eng_file(designs, space, base, tmp_path / "motors.eng", workers=1)
    motors = parse_many(path.read_text())
    assert len(motors) == 2
    names = []
    for head, rows in motors:
        assert len(head) == 7
        assert rows[-1][1] == 0.0 and rows[0][0] > 0
        names.append(head[0])
    assert names[0].endswith("-01") and names[1].endswith("-02")


def test_ric_zip_holds_one_file_per_design(tmp_path):
    base, space, designs = _two_designs()
    path = build_ric_bundle(designs, space, tmp_path / "ric.zip")
    with zipfile.ZipFile(path) as archive:
        names = sorted(archive.namelist())
        assert len(names) == 2 and all(n.endswith(".ric") for n in names)
        archive.extractall(tmp_path)
    again = load_ric(tmp_path / names[1])
    assert again["nozzle"]["throat"] == pytest.approx(designs[1]["throat"])
    assert designs[1]["throat"] != pytest.approx(designs[0]["throat"])
