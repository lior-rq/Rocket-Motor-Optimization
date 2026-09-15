"""The surrogate search: what it learns, what it proposes, when it stops.

The guarantee is that nothing reported comes from the model. The model only
chooses which designs get simulated, so these check that choice: proposals
are never repeats, the front is rebuilt from burns alone, and the closed-form
features the model leans on agree with the simulator.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt.design import DesignSpace, SpaceConfig
from rocketopt.optimize import Objective, surrogate_candidates
from rocketopt.ric import load_ric
from rocketopt.runner import (_design_key, _front_hypervolume, _infill,
                              build_objective, build_space, default_spec)
from rocketopt.sampling import evaluate_batch, mixed_designs
from rocketopt.simulate import simulate_motor
from rocketopt.spec import SURROGATE_ROUNDS, ObjectiveSpec, RunSpec
from rocketopt.surrogate import TARGETS, Surrogate, needed_targets
from tests import sample_motor

MOTOR = sample_motor.path(ROOT)


@pytest.fixture(scope="module")
def base():
    return load_ric(MOTOR)


@pytest.fixture(scope="module")
def space(base):
    return build_space(default_spec(base), base)


@pytest.fixture(scope="module")
def objective(base):
    spec = default_spec(base)
    return build_objective(spec, simulate_motor(base, timestep=0.01), None)


@pytest.fixture(scope="module")
def dataset(space):
    """A small real sample, shared: it is the slow part."""
    return evaluate_batch(space, mixed_designs(space, 96, seed=3), timestep=0.02)


def test_initial_mass_flux_tracks_the_simulated_peak(base):
    """The feature the mass-flux model leans on. Not exact: the simulator's
    peak comes a few steps in, once pressure has risen."""
    space = DesignSpace(base, SpaceConfig())
    names = space.feature_names
    assert "mass_flux_0" in names and "mass_flow_0" in names
    X = mixed_designs(space, 24, seed=1)
    flux_0 = space.features(X)[:, names.index("mass_flux_0")]
    peaks = np.array([simulate_motor(space.to_motor(x), timestep=0.02).peak_mass_flux
                      for x in X])
    ratio = peaks / flux_0
    assert np.all(ratio > 0.4) and np.all(ratio < 1.2)
    assert np.corrcoef(flux_0, peaks)[0, 1] > 0.9


def test_needed_targets_are_the_goals_and_the_limits(objective):
    targets = needed_targets(objective)
    assert set(targets) <= set(TARGETS)
    assert {"initial_thrust", "total_impulse", "max_pressure"} <= set(targets)
    assert "port_throat" not in targets    # closed form, never learned
    assert "burn_time" not in targets      # neither a goal nor a limit here


def test_fit_can_take_a_subset_and_keep_the_rest(space, dataset):
    model = Surrogate(space, seed=0)
    model.fit(dataset, targets=["initial_thrust"])
    assert set(model.models) == {"initial_thrust"}
    model.fit(dataset, targets=["max_pressure"])
    assert set(model.models) == {"initial_thrust", "max_pressure"}
    assert {s.target for s in model.scores} == set(model.models)
    predicted = model.predict(dataset[space.names].to_numpy()[:5])
    assert list(predicted.columns[:2]) == ["initial_thrust", "max_pressure"]
    assert "port_throat" in predicted.columns


def test_infill_never_repeats_a_simulated_design(space, objective, dataset):
    model = Surrogate(space, seed=0)
    model.fit(dataset, targets=needed_targets(objective))
    seen = {_design_key(x) for x in dataset[space.names].to_numpy()}
    proposed = [surrogate_candidates(space, model, objective, pop_size=24,
                                     n_gen=4, seed=s) for s in (0, 1)]
    X = _infill(space, model, objective, proposed, seen, 20)
    keys = [_design_key(x) for x in X]
    assert 0 < len(X) <= 20
    assert len(set(keys)) == len(keys)
    assert not (set(keys) & seen)
    assert np.allclose(space.canonicalize(X), X)


def test_infill_spreads_a_long_front_rather_than_truncating(space, objective, dataset):
    model = Surrogate(space, seed=0)
    model.fit(dataset, targets=needed_targets(objective))
    proposed = [{"front": mixed_designs(space, 60, seed=9),
                 "population": np.zeros((0, space.n_dim))}]
    X = _infill(space, model, objective, proposed, set(), 10)
    assert len(X) == 10
    first = model.predict(X)[objective.objective_labels[0]].to_numpy()
    # An even spread along the leading objective, not the top ten.
    assert first.max() - first.min() > 0.5 * np.ptp(
        model.predict(proposed[0]["front"])[objective.objective_labels[0]].to_numpy())


def test_hypervolume_measures_growth_past_the_old_front(space, objective, dataset):
    hv1, before1, F = _front_hypervolume(dataset, objective, space)
    if hv1 is None:
        pytest.skip("no legal design in the small sample")
    assert before1 is None and F.shape[1] == 2
    hv2, before2, F2 = _front_hypervolume(dataset, objective, space, F)
    assert hv2 == pytest.approx(before2) and np.array_equal(F2, F)
    # A design past the old front's box still counts: the reference follows.
    from rocketopt.optimize import scale_constraints
    legal = dataset[scale_constraints(dataset, objective, space).max(axis=1) <= 0]
    better = legal.iloc[[int(np.argmax(legal["initial_thrust"]))]].copy()
    better["initial_thrust"] *= 1.5
    better["total_impulse"] *= 1.5
    hv3, before3, _ = _front_hypervolume(pd.concat([dataset, better]), objective,
                                         space, F)
    assert hv3 > before3
    # Without a legal design there is nothing to measure, and the front stays.
    none, _, kept = _front_hypervolume(dataset.assign(ok=False), objective, space, F)
    assert none is None and kept is F


def test_budget_splits_the_sample_into_rounds():
    for effort in ("quick", "standard", "thorough", "extreme"):
        b = RunSpec(effort=effort).budget
        assert b["initial"] + b["infill"] * b["rounds"] == b["samples"]
        assert b["initial"] >= b["samples"] // 2
    explicit = RunSpec(effort="standard", budget_simulations=1000).budget
    assert explicit["samples"] == 1000
    # A small budget gets fewer rounds, never an empty or negative sample.
    for samples in (2, 50, 160, 320, 640):
        b = RunSpec(effort="standard", budget_simulations=samples).budget
        assert 1 <= b["rounds"] <= SURROGATE_ROUNDS
        assert b["initial"] + b["infill"] * b["rounds"] == samples
        assert b["initial"] >= samples // 2 >= 1


def test_fit_without_a_holdout_uses_every_row(space, dataset):
    model = Surrogate(space, seed=0)
    model.fit(dataset, targets=["initial_thrust"], test_size=0.0)
    assert set(model.models) == {"initial_thrust"} and model.scores == []
    held = Surrogate(space, seed=0)
    held.fit(dataset, targets=["initial_thrust"])
    X = dataset[space.names].to_numpy()
    assert not np.allclose(model.predict(X)["initial_thrust"],
                           held.predict(X)["initial_thrust"])


def test_three_objectives_give_a_three_column_front(space, dataset):
    objective = Objective(objectives=(
        ObjectiveSpec("initial_thrust"), ObjectiveSpec("total_impulse"),
        ObjectiveSpec("max_pressure", direction="min")))
    model = Surrogate(space, seed=0)
    model.fit(dataset, targets=needed_targets(objective))
    out = surrogate_candidates(space, model, objective, pop_size=24, n_gen=3, seed=0)
    assert out["population"].shape == (24, space.n_dim)
    assert objective.matrix(model.predict(out["population"]).assign(ok=True)).shape[1] == 3
