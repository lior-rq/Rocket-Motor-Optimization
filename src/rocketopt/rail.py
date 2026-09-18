"""Speed off the launch rail, from a thrust curve and a liftoff mass.

A point mass on a straight rail tilted from vertical. Thrust acts along the
rail and gravity's component against it; drag and rail friction are ignored,
which under 30 m/s is a fraction of a percent. The mass is held at its liftoff
value for the whole rail run, as in the team's standalone calculation, so the
result reads a little low and errs safe.
"""

from __future__ import annotations

import math

import numpy as np

G = 9.80665


def rail_exit_velocity(time, thrust, mass: float, length: float,
                       angle_deg: float = 7.0) -> float:
    """Speed once the rocket has travelled ``length`` along the rail, in m/s.

    Thrust is linear between samples, so the trapezoid rule integrates the
    acceleration exactly. Zero when the rocket never gets that far: thrust
    under weight, or burnout too early.
    """
    t = np.asarray(time, dtype=float)
    f = np.asarray(thrust, dtype=float)
    if mass <= 0 or length <= 0 or t.size < 2:
        return 0.0
    g_rail = G * math.cos(math.radians(angle_deg))
    accel = f / mass - g_rail
    dt = np.diff(t)
    steps = 0.5 * (accel[1:] + accel[:-1]) * dt
    signed = np.concatenate([[0.0], np.cumsum(steps)])
    # The rail holds the rocket on the pad: velocity is the signed integral
    # reflected at zero, which never lets it slide backwards.
    v = signed - np.minimum.accumulate(np.minimum(signed, 0.0))
    x = np.concatenate([[0.0], np.cumsum(0.5 * (v[1:] + v[:-1]) * dt)])

    past = np.flatnonzero(x >= length)
    if past.size:
        i = int(past[0])
        if i == 0:
            return float(v[0])
        span = x[i] - x[i - 1]
        frac = (length - x[i - 1]) / span if span > 0 else 1.0
        # v^2 is linear in distance under the step's near-constant acceleration.
        return float(math.sqrt(v[i - 1] ** 2 + frac * (v[i] ** 2 - v[i - 1] ** 2)))
    # Burnout before the end of the rail: coast against gravity alone.
    remaining = v[-1] ** 2 - 2.0 * g_rail * (length - x[-1])
    return float(math.sqrt(remaining)) if remaining > 0 else 0.0


def max_hardware_mass(time, thrust, prop_mass: float, target: float,
                      length: float, angle_deg: float = 7.0) -> float:
    """Heaviest dry rocket this curve still gets to ``target`` off the rail.

    Exit speed falls with mass, so a bisection finds it. NaN when even a
    weightless airframe falls short.
    """
    def speed(hardware: float) -> float:
        return rail_exit_velocity(time, thrust, hardware + prop_mass, length,
                                  angle_deg)

    if not (target > 0) or speed(0.0) < target:
        return float("nan")
    lo, hi = 0.0, 1.0
    while speed(hi) >= target:
        hi *= 2.0
        if hi > 1e5:
            return float("inf")
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if speed(mid) >= target:
            lo = mid
        else:
            hi = mid
    return lo
