"""Surrogate models that predict burn outcomes without running openMotor.

Only the quantities that need integrating the whole burn. Port/throat, initial
Kn and propellant mass are closed-form in :mod:`rocketopt.design`, so learning
them would only add error.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

#: Quantities the optimiser needs that are not available in closed form.
TARGETS: List[str] = [
    "initial_thrust",
    "total_impulse",
    "max_pressure",
    "peak_mass_flux",
    "peak_thrust",
    "isp",
    "burn_time",
    "thrust_variation",
    "peak_kn",
    # Added so the app can optimise or constrain any offered metric without
    # falling back to the simulator mid-search.
    "avg_thrust",
    "avg_pressure",
    "volume_loading",
    "peak_mach",
    "residual_pct",
]

#: Quantities computed exactly by DesignSpace.features, so never learned.
ANALYTIC = {
    "port_throat": "port_throat_0",
    "initial_kn": "kn_0",
    "prop_mass": "prop_mass",
}


def needed_targets(objective) -> List[str]:
    """The learned quantities a search actually reads: its objectives and its
    limits. Fitting the rest each round would only slow the loop."""
    wanted = ([s.metric for s in objective.objectives]
              or ["initial_thrust", "total_impulse"])
    wanted += ([c.metric for c in objective.constraints
                if getattr(c, "enabled", True)]
               or ["max_pressure", "peak_mass_flux", "peak_kn", "avg_pressure"])
    return [t for t in TARGETS if t in set(wanted)]


def build_model(kind: str = "gbt", seed: int = 0):
    if kind == "gbt":
        # Small trees, many of them, no early stop: on a few thousand rows
        # the validation set is too small to stop on, and the shallow
        # ensemble scored best on the constraint metrics.
        return HistGradientBoostingRegressor(
            max_iter=400, learning_rate=0.06, max_leaf_nodes=15,
            min_samples_leaf=5, l2_regularization=1e-3,
            early_stopping=False, random_state=seed,
        )
    if kind == "rf":
        return RandomForestRegressor(
            n_estimators=300, min_samples_leaf=2, n_jobs=-1, random_state=seed
        )
    if kind == "mlp":
        return make_pipeline(
            StandardScaler(),
            MLPRegressor(
                hidden_layer_sizes=(128, 128, 64), activation="relu",
                learning_rate_init=2e-3, max_iter=800, early_stopping=True,
                n_iter_no_change=25, random_state=seed,
            ),
        )
    raise ValueError("unknown model kind {!r}".format(kind))


@dataclass
class TargetScore:
    target: str
    r2: float
    mae: float
    mape: float

    def as_row(self) -> Dict:
        return {"target": self.target, "r2": self.r2, "mae": self.mae, "mape": self.mape}


class Surrogate:
    """One regressor per target, sharing the physics feature vector as input."""

    def __init__(self, space, kind: str = "gbt", seed: int = 0) -> None:
        self.space = space
        self.kind = kind
        self.seed = seed
        self.models: Dict[str, object] = {}
        self.scores: List[TargetScore] = []
        self.feature_names = list(space.feature_names)

    # ------------------------------------------------------------- training

    def fit(self, frame: pd.DataFrame, test_size: float = 0.2,
            targets: Optional[Iterable[str]] = None) -> List[TargetScore]:
        """Trains on successfully simulated designs, feasible or not.

        Infeasible ones are kept so the constraint boundary is visible from
        both sides. Failed simulations carry no targets and are dropped.
        ``targets`` limits the fit to some of :data:`TARGETS`; others already
        fitted are kept. A ``test_size`` of 0 fits on every row and scores
        nothing.
        """
        usable = frame[frame["ok"]].reset_index(drop=True)
        X = usable[self.feature_names].to_numpy(dtype=float)
        if test_size:
            idx_train, idx_test = train_test_split(
                np.arange(len(usable)), test_size=test_size, random_state=self.seed
            )
        else:
            idx_train, idx_test = np.arange(len(usable)), np.arange(0)
        targets = list(targets) if targets is not None else list(TARGETS)
        self.scores = [s for s in self.scores if s.target not in targets]
        for target in targets:
            y = usable[target].to_numpy(dtype=float)
            model = build_model(self.kind, self.seed)
            # One thread: on a few thousand rows OpenMP spends more time
            # synchronising than working, and the fit takes ten times longer.
            with threadpool_limits(1):
                model.fit(X[idx_train], y[idx_train])
                self.models[target] = model
                if not len(idx_test):
                    continue
                pred = model.predict(X[idx_test])
            actual = y[idx_test]
            denom = np.maximum(np.abs(actual), 1e-9)
            self.scores.append(
                TargetScore(
                    target=target,
                    r2=float(r2_score(actual, pred)),
                    mae=float(mean_absolute_error(actual, pred)),
                    mape=float(np.mean(np.abs(pred - actual) / denom) * 100.0),
                )
            )
        return self.scores

    # ----------------------------------------------------------- prediction

    def predict(self, X_design: np.ndarray) -> pd.DataFrame:
        """Predicts every target for a batch of design vectors."""
        features = self.space.features(np.atleast_2d(X_design))
        with threadpool_limits(1):
            out = pd.DataFrame(
                {target: model.predict(features) for target, model in self.models.items()}
            )
        frame = pd.DataFrame(features, columns=self.feature_names)
        for name, source in ANALYTIC.items():
            out[name] = frame[source].to_numpy()
        return out

    # ------------------------------------------------------------ diagnostics

    def importances(self, frame: pd.DataFrame, target: str, n_repeats: int = 8,
                    n_samples: int = 2000) -> pd.DataFrame:
        usable = frame[frame["ok"]]
        usable = usable.sample(min(n_samples, len(usable)), random_state=self.seed)
        X = usable[self.feature_names].to_numpy(dtype=float)
        y = usable[target].to_numpy(dtype=float)
        result = permutation_importance(
            self.models[target], X, y, n_repeats=n_repeats,
            random_state=self.seed, n_jobs=-1,
        )
        return (
            pd.DataFrame(
                {"feature": self.feature_names,
                 "importance": result.importances_mean,
                 "std": result.importances_std}
            )
            .sort_values("importance", ascending=False)
            .reset_index(drop=True)
        )

    # ---------------------------------------------------------- persistence

