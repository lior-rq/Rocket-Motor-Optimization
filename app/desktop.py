"""Runs the app in its own window instead of a browser tab.

The server is unchanged: uvicorn serves ``app.server:app`` on a loopback
port picked at random, and pywebview opens a native window on it. Nothing
here touches simulation code; it only changes how the UI is presented and
how a design gets saved to disk.
"""

from __future__ import annotations

import base64
import logging.handlers
import os
import string
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Dict, Optional

from . import paths

#: One look for the splash and the failure page, which replace each other.
_PAGE_STYLE = ("background:#0b0b0b;color:#fcfcfb;font-size:14px;"
               "font-family:-apple-system,'Segoe UI',sans-serif")

#: Shown the instant the window opens, before the backend has imported
#: numpy/sklearn/motorlib. Replaced by load_url once the server answers.
_SPLASH_HTML = string.Template("""
<html><body style="margin:0;height:100vh;display:flex;align-items:center;
justify-content:center;$style">
<p>Starting Rocket Optimizer&hellip;</p>
</body></html>
""").substitute(style=_PAGE_STYLE)

#: string.Template, so CSS braces need no escaping.
_FAILURE_HTML = string.Template("""
<html><body style="margin:0;padding:32px;$style">
<p style="font-size:16px;margin:0 0 8px">Rocket Optimizer could not start.</p>
<p style="color:#a8a8a4;margin:0 0 16px">$log</p>
<pre style="white-space:pre-wrap;color:#f0a0a0;font-size:12px">$detail</pre>
</body></html>
""")


def _free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _setup_logging() -> Optional[Path]:
    """Windowed builds have no console; send prints to a file instead.

    Without this, every ``traceback.print_exc()`` in jobs.py vanishes.
    Returns the log path, or None while output still reaches a console.
    """
    if not (paths.FROZEN or sys.stdout is None):
        return None
    log_path = paths.LOG_FILE
    try:
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            log_path.unlink()
        handle = open(log_path, "a", buffering=1, encoding="utf-8")
    except OSError:
        return None
    sys.stdout = handle
    sys.stderr = handle
    return log_path


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


class _ServerThread(threading.Thread):
    """Runs uvicorn and keeps whatever stopped it, for the failure page.

    A failed bind only reaches uvicorn's logger before its ``sys.exit(1)``,
    which a bare thread would swallow.
    """

    def __init__(self, server) -> None:
        super().__init__(name="uvicorn", daemon=True)
        self.server = server
        self.log = logging.handlers.BufferingHandler(64)
        self.log.setLevel(logging.ERROR)
        self.crash = ""

    def run(self) -> None:
        logger = logging.getLogger("uvicorn.error")
        logger.addHandler(self.log)
        try:
            self.server.run()
        except BaseException:
            self.crash = traceback.format_exc()
            raise
        finally:
            logger.removeHandler(self.log)

    def error(self) -> str:
        lines = [self.log.format(record) for record in self.log.buffer]
        return "\n".join(lines + [self.crash]).strip()


def _start_server(port: int):
    """Starts uvicorn on a daemon thread. Returns (server, thread)."""
    import uvicorn

    from .server import app as fastapi_app

    config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=port,
                            log_level="warning")
    server = uvicorn.Server(config)
    thread = _ServerThread(server)
    thread.start()
    return server, thread


def _wait_until_started(server, thread, timeout: float = float("inf")) -> bool:
    """False once the server thread has died, or ``timeout`` has passed."""
    deadline = time.monotonic() + timeout
    while (not server.started and thread.is_alive()
           and time.monotonic() < deadline):
        time.sleep(0.05)
    return server.started


def _failure_html(detail: str, log: Optional[Path] = None) -> str:
    """What the window shows when the backend never comes up."""
    import html

    where = ("The full log is at " + html.escape(str(log))) if log else ""
    return _FAILURE_HTML.substitute(style=_PAGE_STYLE, log=where,
                                    detail=html.escape(detail))


class DesktopApi:
    """Exposed to the page as ``window.pywebview.api``.

    ``_jobs`` and ``_window`` are filled in by ``boot`` once the server module
    has been imported, which is after this object is handed to
    ``webview.create_window`` -- js_api calls cannot arrive before then,
    since the real page has not loaded yet.

    Public attributes MUST be methods. pywebview walks every other public
    attribute recursively to build the JS API; on Windows that walk descends
    into the WinForms window and never returns.
    """

    def __init__(self) -> None:
        self._jobs = None
        self._window = None

    def bind(self, jobs, window) -> None:
        self._jobs = jobs
        self._window = window

    def save_file(self, filename: str, data_b64: str) -> Dict[str, object]:
        """A native Save dialog in place of a browser download."""
        import webview

        try:
            data = base64.b64decode(data_b64)
        except Exception as exc:
            return {"error": "Bad file data: {}".format(exc)}
        paths.ensure_dirs()
        result = self._window.create_file_dialog(
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
        if self._jobs is None:
            return {"error": "Not ready yet."}
        job = self._jobs.get(job_id)
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


def _unblock_frozen_dlls() -> None:
    """Strips Windows' "downloaded from the internet" mark from our DLLs.

    Explorer tags every file it extracts from a downloaded zip with a
    hidden Zone.Identifier stream. .NET Framework refuses to load a managed
    DLL carrying it, so pywebview's ``import clr`` fails with "Failed to
    resolve Python.Runtime.Loader.Initialize" (pythonnet/pywebview#1215).
    Deleting the stream is what right-click > Properties > Unblock does.
    """
    if os.name != "nt" or not paths.FROZEN:
        return
    root = os.path.dirname(sys.executable)
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".dll"):
                try:
                    os.remove(os.path.join(dirpath, name) + ":Zone.Identifier")
                except OSError:
                    pass  # not blocked, or not on NTFS; nothing to strip


def _run_gui(log: Optional[Path]) -> None:
    _unblock_frozen_dlls()
    import webview

    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.settings["ALLOW_DOWNLOADS"] = True

    api = DesktopApi()
    window = webview.create_window(
        "Rocket Optimizer", html=_SPLASH_HTML, js_api=api,
        width=1280, height=860, min_size=(960, 640), text_select=True)

    state: Dict[str, tuple] = {}

    def boot(window) -> None:
        try:
            port = _free_port()
            server, thread = _start_server(port)
            state["boot"] = (server, thread)
            if _wait_until_started(server, thread):
                from .server import jobs as job_registry
                api.bind(job_registry, window)
                window.load_url("http://127.0.0.1:{}".format(port))
                return
            detail = ("The server stopped before it was ready.\n"
                      + thread.error())
        except Exception:
            detail = traceback.format_exc()
        try:
            print(detail, file=sys.stderr)
        except OSError:
            pass  # a full disk must not also cost the page below
        # Not before the splash has loaded: WebView2 would replace the page
        # with it. Never loaded means there is no window to show it in.
        if window.events.loaded.wait(15):
            window.load_html(_failure_html(detail, log))

    # A source run has no .icns/.ico, so the OS dock/taskbar falls back to
    # Python's own default icon. Frozen builds already carry the real icon
    # via desktop.spec (EXE/BUNDLE icon=), so this path won't exist there
    # and pywebview silently skips it.
    icon = str(paths.ROOT / "icons" / "app-icon.png")
    webview.start(func=boot, args=(window,), icon=icon)

    # webview.start() returns once every window is closed (including Cmd-Q).
    if "boot" in state:
        _shutdown(*state["boot"])
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
    # A slow/cold CI runner, not just this machine: generous on purpose.
    if not _wait_until_started(server, thread, timeout=60):
        print("smoke: server did not start", file=sys.stderr)
        return 1

    base = "http://127.0.0.1:{}".format(port)
    try:
        urllib.request.urlopen(base + "/", timeout=30).read()
        # A real simulation, not just a route -- first call pays for any
        # lazy import still pending, so it gets the same generous budget.
        urllib.request.urlopen(base + "/api/defaults", timeout=60).read()
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
    log = _setup_logging()
    # Read by app.server at import time, so it must be set before _start_server
    # (directly or via _run_smoke/_run_gui) imports it.
    os.environ.setdefault("ROCKETOPT_DESKTOP", "1")

    if "--smoke" in sys.argv:
        raise SystemExit(_run_smoke())
    _run_gui(log)
