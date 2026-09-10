"""RASP ``.eng`` files, the format OpenRocket and RockSim read.

One file per design on the trade-off curve, zipped. Every curve here is a real
openMotor run at the verification timestep, so an ``.eng`` agrees with the
numbers the report quotes for the same design.

What the format cannot carry is casing mass: RASP has one total-mass field and
this application never models hardware. Total mass is therefore written as the
propellant mass alone, and every file says so in its header. Adding the casing
is the user's job before the file is trusted for an altitude simulation.
"""

from __future__ import annotations

import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

import numpy as np

from .simulate import curves, simulate_motor

#: Never write more than this many, matching the design sheets.
MAX_FILES = 60

#: Points kept per curve. RASP is read as a piecewise-linear table, and a few
#: hundred samples of a five-second burn is finer than any flight simulator
#: integrates at.
CURVE_POINTS = 128

#: Whitespace separates the header fields, so none of them may contain any.
MANUFACTURER = "LiorsRocketOptimizer"

ProgressFn = Callable[[int, int, str], None]


def _noop(done: int, total: int, message: str) -> None:
    return None


def resample(time: Sequence[float], thrust: Sequence[float],
             points: int = CURVE_POINTS) -> List[List[float]]:
    """Thins a curve to ``points`` samples, keeping burnout and the peak.

    Uniform sampling alone rounds off the peak and can miss the step at each
    grain's burnout, which is the shape a BATES stack is recognised by.
    """
    t = np.asarray(time, dtype=float)
    f = np.asarray(thrust, dtype=float)
    if t.size < 2:
        return []

    # Everything from ignition to the last instant of positive thrust.
    live = np.flatnonzero(f > 0)
    if not live.size:
        return []
    start, end = live[0], live[-1]
    t, f = t[start:end + 1], f[start:end + 1]

    keep = set(np.linspace(0, t.size - 1, min(points, t.size)).round().astype(int))
    keep.add(int(np.argmax(f)))
    # The largest drops between samples are the grain burnout steps.
    if t.size > 3:
        steps = np.argsort(np.abs(np.diff(f)))[-8:]
        for i in steps:
            keep.add(int(i)); keep.add(int(i) + 1)
    index = sorted(i for i in keep if 0 <= i < t.size)

    rows = [[float(t[i]), float(f[i])] for i in index]
    # RASP wants a strictly rising time column starting after zero.
    out: List[List[float]] = []
    for moment, force in rows:
        if moment <= 0:
            continue
        if out and moment <= out[-1][0]:
            continue
        out.append([moment, force])
    if not out:
        return []
    # A curve that never reaches zero leaves the motor burning forever.
    tail = out[-1][0] + max(out[-1][0] * 0.002, 1e-3)
    out.append([tail, 0.0])
    return out


def eng_text(name: str, rows: Sequence[Sequence[float]], diameter_mm: float,
             length_mm: float, prop_mass_kg: float,
             notes: Sequence[str] = ()) -> str:
    """One motor as RASP text. ``rows`` is ``[[seconds, newtons], ...]``."""
    lines = [
        "; {} -- written by Lior's Really Good(TM) Rocket Optimizer".format(name),
        "; Simulated in openMotor at a 0.002 s timestep.",
        "; Total mass is the propellant only: casing, nozzle and closures are",
        "; not modelled here, so add the hardware mass before flying this.",
    ]
    lines += ["; " + note for note in notes]
    lines.append("{} {:.1f} {:.1f} P {:.4f} {:.4f} {}".format(
        name, diameter_mm, length_mm, prop_mass_kg, prop_mass_kg, MANUFACTURER))
    lines += ["   {:.4f} {:.3f}".format(moment, force) for moment, force in rows]
    lines.append(";")
    return "\n".join(lines) + "\n"


def _file_name(design: Dict, index: int) -> str:
    stem = "".join(c for c in str(design.get("designation", "")) if c.isalnum())
    return "{:02d}-{}.eng".format(index + 1, stem or "design")


def _motor_name(design: Dict, index: int) -> str:
    stem = "".join(c for c in str(design.get("designation", "")) if c.isalnum())
    return "{}-{:02d}".format(stem or "Design", index + 1)


def _simulate(motor: Dict) -> Dict:
    """One design's curve and mass. Runs in a worker process."""
    result = curves(motor, timestep=0.002)
    return {"time": result["time"], "thrust": result["thrust"],
            "prop_mass": float(simulate_motor(motor, timestep=0.002).prop_mass)}


def design_eng(design: Dict, index: int, motor: Dict,
               measured: Optional[Dict] = None) -> Optional[str]:
    """One design as RASP text, or None when it has no usable curve."""
    grains = motor["grains"]
    source = measured or design.get("curves") or {}
    rows = resample(source.get("time") or [], source.get("thrust") or [])
    if not rows:
        return None
    prop_mass = (measured or {}).get("prop_mass")
    if prop_mass is None:
        prop_mass = design.get("prop_mass")
    if prop_mass is None:
        prop_mass = float(simulate_motor(motor, timestep=0.002).prop_mass)

    diameter = grains[0]["properties"]["diameter"] * 1000.0
    length = sum(g["properties"]["length"] for g in grains) * 1000.0
    cores = ", ".join("{:.3f} in".format(
        g["properties"]["coreDiameter"] / 0.0254) for g in grains)
    notes = [
        "Diameter is the grain outer diameter and length is the grain stack;",
        "neither includes the case or nozzle.",
        "Cores, forward to aft: {}".format(cores),
        "Throat {:.3f} in, exit {:.3f} in.".format(
            motor["nozzle"]["throat"] / 0.0254, motor["nozzle"]["exit"] / 0.0254),
    ]
    return eng_text(_motor_name(design, index), rows, diameter, length,
                    float(prop_mass), notes)


def build_eng_bundle(designs: Sequence[Dict], space, base_motor: Dict,
                     out_path: Path, on_progress: ProgressFn = _noop,
                     workers: Optional[int] = None) -> Path:
    """Writes one ``.eng`` per design into a zip at ``out_path``.

    Only the first few designs come back from a run with curves attached, so
    the rest are simulated here. That is one full-fidelity run each, which is
    why it happens in a pool and reports progress.
    """
    designs = list(designs)[:MAX_FILES]
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not designs:
        raise ValueError("That run found no legal designs.")

    motors = [space.to_motor(np.asarray(d["x"], dtype=float)) for d in designs]
    total = len(designs)
    on_progress(0, total, "Simulating {} designs".format(total))

    measured: List[Optional[Dict]] = [None] * total
    done = 0
    with ProcessPoolExecutor(max_workers=workers or 4) as pool:
        for i, result in enumerate(pool.map(_simulate, motors)):
            measured[i] = result
            done += 1
            on_progress(done, total, "Simulated {} of {}".format(done, total))

    written = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for i, design in enumerate(designs):
            text = design_eng(design, i, motors[i], measured[i])
            if text is None:
                continue
            archive.writestr(_file_name(design, i), text)
            written += 1
        archive.writestr("README.txt", _readme(written))
    on_progress(total, total, "Ready")
    return out_path


def _readme(count: int) -> str:
    return (
        "{} RASP .eng files, one per design on the trade-off curve.\n\n"
        "Each is a real openMotor simulation at a 0.002 s timestep, so the\n"
        "numbers agree with this run's report.\n\n"
        "Before flying any of these in OpenRocket or RockSim: the total mass\n"
        "in an .eng file is the propellant mass alone. This application never\n"
        "models the case, nozzle or closures, so the hardware mass has to be\n"
        "added by hand. Diameter and length are the grain outer diameter and\n"
        "the grain stack length for the same reason.\n\n"
        "To use one, drop the file into OpenRocket's user motor directory, or\n"
        "load it from the motor selection dialog.\n".format(count))
