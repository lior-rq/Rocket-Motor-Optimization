"""Runs the app in its own window instead of a browser tab.

The server is unchanged: uvicorn serves ``app.server:app`` on a loopback
port picked at random, and pywebview opens a native window on it. Nothing
here touches simulation code; it only changes how the UI is presented and
how a design gets saved to disk.
"""

from __future__ import annotations

import base64
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, Optional

from . import paths

#: Shown the instant the window opens, before the backend has imported
#: numpy/sklearn/motorlib. Replaced by load_url once the server answers.
_SPLASH_HTML = """
<html><body style="margin:0;height:100vh;display:flex;align-items:center;
justify-content:center;background:#0b0b0b;color:#fcfcfb;
font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px">
<p>Starting Rocket Optimizer&hellip;</p>
</body></html>
"""


def _free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _setup_logging() -> None:
    """Windowed builds have no console; send prints to a file instead.

    Without this, every ``traceback.print_exc()`` in jobs.py vanishes.
    """
    if not (paths.FROZEN or sys.stdout is None):
        return
    log_path = paths.LOG_DIR / "rocket-optimizer.log"
    try:
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            log_path.unlink()
        handle = open(log_path, "a", buffering=1, encoding="utf-8")
    except OSError:
        return
    sys.stdout = handle
    sys.stderr = handle


def open_with_system(target) -> None:
    """Opens a file or URL with whatever the OS considers default.

    Generalises app.py's ``open_browser`` to any path, not just the app's
    own URL, since the desktop build has no browser tab to fall back on.
    """
    target = str(target)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", target], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        elif os.name == "nt":
            os.startfile(target)                                # noqa: S606
        else:
            subprocess.Popen(["xdg-open", target], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    except Exception:
        pass  # opening the file is a courtesy; the file itself is saved either way


def _start_server(port: int):
    """Starts uvicorn on a daemon thread. Returns (server, thread)."""
    import uvicorn

    from .server import app as fastapi_app

    config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=port,
                            log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="uvicorn", daemon=True)
    thread.start()
    return server, thread


def _wait_until_started(server, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    return server.started


class DesktopApi:
    """Exposed to the page as ``window.pywebview.api``.

    ``jobs`` and ``window`` are filled in by ``boot`` once the server module
    has been imported, which is after this object is handed to
    ``webview.create_window`` -- js_api calls cannot arrive before then,
    since the real page has not loaded yet.
    """

    def __init__(self) -> None:
        self.jobs = None
        self.window = None

    def bind(self, jobs, window) -> None:
        self.jobs = jobs
        self.window = window

    def save_file(self, filename: str, data_b64: str) -> Dict[str, object]:
        """A native Save dialog in place of a browser download."""
        import webview

        try:
            data = base64.b64decode(data_b64)
        except Exception as exc:
            return {"error": "Bad file data: {}".format(exc)}
        paths.ensure_dirs()
        result = self.window.create_file_dialog(
            webview.FileDialog.SAVE, directory=str(paths.DATA_DIR),
            save_filename=filename)
        if not result:
            return {"cancelled": True}
        target = Path(result[0] if isinstance(result, (list, tuple)) else result)
        try:
            target.write_bytes(data)
        except OSError as exc:
            return {"error": str(exc)}
        return {"saved": str(target)}

    def open_report(self, job_id: str) -> Dict[str, str]:
        if self.jobs is None:
            return {"error": "Not ready yet."}
        job = self.jobs.get(job_id)
        if job is None or job.report is None or not job.report.exists():
            return {"error": "No report for that run."}
        open_with_system(job.report)
        return {"opened": str(job.report)}

    def show_files(self) -> Dict[str, str]:
        paths.ensure_dirs()
        open_with_system(paths.DATA_DIR)
        return {"opened": str(paths.DATA_DIR)}


def _shutdown(server, thread) -> None:
    """Stops background work, then exits hard so nothing lingers."""
    from .server import jobs as job_registry

    job_registry.cancel_all()
    server.should_exit = True
    thread.join(timeout=3)

    # Optimise/bundle threads exit at their next progress callback, which
    # closes their SimulationPool. Give that a moment before the hard exit.
    deadline = time.time() + 5
    while time.time() < deadline:
        active = [t for t in threading.enumerate()
                 if t.name.startswith(("optimise-", "bundle-"))]
        if not active:
            break
        time.sleep(0.1)
    os._exit(0)


def _run_gui() -> None:
    import webview

    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.settings["ALLOW_DOWNLOADS"] = True

    api = DesktopApi()
    window = webview.create_window(
        "Rocket Optimizer", html=_SPLASH_HTML, js_api=api,
        width=1280, height=860, min_size=(960, 640), text_select=True)

    state: Dict[str, object] = {}

    def boot(window) -> None:
        port = _free_port()
        server, thread = _start_server(port)
        state["server"], state["thread"] = server, thread
        if not _wait_until_started(server):
            return  # the splash stays up; the log has whatever went wrong
        from .server import jobs as job_registry
        api.bind(job_registry, window)
        window.load_url("http://127.0.0.1:{}".format(port))

    webview.start(func=boot, args=(window,))

    # webview.start() returns once every window is closed (including Cmd-Q).
    server, thread = state.get("server"), state.get("thread")
    if server is not None:
        _shutdown(server, thread)
    else:
        os._exit(0)


def _run_smoke() -> int:
    """No window: starts the server and proves a frozen build actually runs.

    Exercises the parts freezing can break -- hidden imports, the Cython/
    scikit-fmm extensions, and multiprocessing workers under spawn.
    """
    import urllib.request

    port = _free_port()
    server, thread = _start_server(port)
    if not _wait_until_started(server):
        print("smoke: server did not start", file=sys.stderr)
        return 1

    base = "http://127.0.0.1:{}".format(port)
    try:
        urllib.request.urlopen(base + "/", timeout=10).read()
        urllib.request.urlopen(base + "/api/defaults", timeout=10).read()
    except Exception as exc:
        print("smoke: request failed: {}".format(exc), file=sys.stderr)
        return 1

    from .server import THROUGHPUT
    deadline = time.time() + 120
    while THROUGHPUT.get("source") != "measured" and time.time() < deadline:
        time.sleep(0.5)
    if THROUGHPUT.get("source") != "measured":
        print("smoke: calibration did not complete", file=sys.stderr)
        return 1

    print("smoke: ok, rate={:.1f} sims/s".format(THROUGHPUT["rate"]))
    server.should_exit = True
    thread.join(timeout=5)
    return 0


def main() -> None:
    paths.ensure_dirs()
    _setup_logging()
    # Read by app.server at import time, so it must be set before _start_server
    # (directly or via _run_smoke/_run_gui) imports it.
    os.environ.setdefault("ROCKETOPT_DESKTOP", "1")

    if "--smoke" in sys.argv:
        raise SystemExit(_run_smoke())
    _run_gui()
