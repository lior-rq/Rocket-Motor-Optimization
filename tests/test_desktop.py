"""app.desktop: the pywebview shell and the JS bridge it exposes.

DesktopApi.save_file imports webview lazily (see app/desktop.py), so these
tests stub sys.modules["webview"] rather than depending on pywebview being
installed -- it ships in requirements-desktop.txt, not requirements.txt.
"""

import base64
import json
import sys
import types

import pytest

from app.desktop import DesktopApi
from app.jobs import Job, JobRegistry


class _StubWindow:
    def __init__(self, dialog_result):
        self._dialog_result = dialog_result

    def create_file_dialog(self, dialog_type, directory="", save_filename=""):
        return self._dialog_result


@pytest.fixture
def fake_webview(monkeypatch):
    stub = types.SimpleNamespace(FileDialog=types.SimpleNamespace(SAVE=30))
    monkeypatch.setitem(sys.modules, "webview", stub)
    return stub


def test_save_file_writes_decoded_bytes(tmp_path, fake_webview, monkeypatch):
    from app import paths
    monkeypatch.setattr(paths, "DATA_DIR", tmp_path)
    target = tmp_path / "best-so-far.ric"
    api = DesktopApi()
    api.bind(jobs=None, window=_StubWindow(dialog_result=[str(target)]))

    data = b"this is not really a .ric file"
    result = api.save_file("best-so-far.ric", base64.b64encode(data).decode())

    assert result == {"saved": str(target)}
    assert target.read_bytes() == data


def test_save_file_reports_a_cancelled_dialog(tmp_path, fake_webview, monkeypatch):
    from app import paths
    monkeypatch.setattr(paths, "DATA_DIR", tmp_path)
    api = DesktopApi()
    api.bind(jobs=None, window=_StubWindow(dialog_result=None))

    result = api.save_file("design.ric", base64.b64encode(b"x").decode())

    assert result == {"cancelled": True}


def test_open_report_on_unknown_job_is_an_error():
    api = DesktopApi()
    api.bind(jobs=JobRegistry(), window=None)

    result = api.open_report("no-such-job")

    assert "error" in result


def test_cancel_all_stops_every_running_job():
    registry = JobRegistry()
    running = Job(id="running-job")
    running.status = "running"
    done = Job(id="done-job")
    done.status = "done"
    with registry._lock:
        for job in (running, done):
            registry._jobs[job.id] = job
            registry._order.append(job.id)

    registry.cancel_all()

    assert running.status == "cancelled"
    assert running._cancel.is_set()
    assert done.status == "done"          # already finished; left alone


def test_about_reports_version_and_platform():
    from app.server import about
    from rocketopt import __version__

    payload = json.loads(about().body)

    assert payload["version"] == __version__
    assert isinstance(payload["desktop"], bool)
    assert payload["platform"] in ("mac", "windows", "linux")
