"""Where the app reads and writes, in source and frozen builds alike.

A source checkout writes into the repo, as it always has. A frozen build's
own folder is read-only (inside a signed .app, or wherever a zip was
extracted), so it writes under the user's Documents instead.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: True inside a PyInstaller build; the attribute does not exist otherwise.
FROZEN = bool(getattr(sys, "frozen", False))


def _default_data_dir() -> Path:
    if not FROZEN:
        return ROOT
    documents = Path.home() / "Documents"
    base = documents if documents.is_dir() else Path.home()
    return base / "Rocket Optimizer"


#: Overridable so a smoke test (or an unusual setup) can point elsewhere.
_override = os.environ.get("ROCKETOPT_HOME")
DATA_DIR = Path(_override).expanduser() if _override else _default_data_dir()

MOTOR_DIR = DATA_DIR / "motor"
REPORTS_DIR = DATA_DIR / "reports"
OUTPUTS_DIR = DATA_DIR / "outputs"
LOG_DIR = DATA_DIR / "logs"


def ensure_dirs() -> None:
    for d in (MOTOR_DIR, REPORTS_DIR, OUTPUTS_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)
