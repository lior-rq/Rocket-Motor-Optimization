"""app.paths: where the desktop build reads and writes vs. source runs.

DATA_DIR etc. are computed at import time, so each scenario reloads the
module under a patched environment rather than calling a function.
"""

import importlib
import os
import sys

import pytest

from app import paths as paths_module


def _reload():
    return importlib.reload(paths_module)


@pytest.fixture(autouse=True)
def _restore_module_state():
    """Leaves app.paths as a fresh import would, for tests that follow."""
    yield
    os.environ.pop("ROCKETOPT_HOME", None)
    if hasattr(sys, "frozen"):
        del sys.frozen
    _reload()


def test_source_run_uses_repo_root():
    mod = _reload()
    assert not mod.FROZEN
    assert mod.DATA_DIR == mod.ROOT


def test_rocketopt_home_overrides_everything(tmp_path, monkeypatch):
    monkeypatch.setenv("ROCKETOPT_HOME", str(tmp_path))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    mod = _reload()
    assert mod.DATA_DIR == tmp_path


def test_frozen_uses_documents_when_present(tmp_path, monkeypatch):
    (tmp_path / "Documents").mkdir()
    monkeypatch.setattr(paths_module.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    mod = _reload()
    assert mod.DATA_DIR == tmp_path / "Documents" / "Rocket Optimizer"


def test_frozen_falls_back_without_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(paths_module.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    mod = _reload()
    assert mod.DATA_DIR == tmp_path / "Rocket Optimizer"


def test_ensure_dirs_creates_every_subfolder(tmp_path, monkeypatch):
    monkeypatch.setenv("ROCKETOPT_HOME", str(tmp_path))
    mod = _reload()
    mod.ensure_dirs()
    assert mod.MOTOR_DIR.is_dir()
    assert mod.REPORTS_DIR.is_dir()
    assert mod.OUTPUTS_DIR.is_dir()
    assert mod.LOG_DIR.is_dir()
