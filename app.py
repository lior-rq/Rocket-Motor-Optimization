#!/usr/bin/env python
"""Starts Lior's Really Good™ Rocket Optimizer and opens it in a browser.

Run it with `python app.py`. On a machine that has never run it before it offers
to build the environment first, then starts itself inside it -- so this is the
only command anybody needs.
"""
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

HOST = "127.0.0.1"
PORT = 8420


def ready() -> bool:
    """Can this interpreter run the app as it stands?"""
    try:
        import fastapi        # noqa: F401
        import uvicorn        # noqa: F401
        from motorlib.motor import Motor        # noqa: F401
    except Exception:
        return False
    return True


def relaunch_in_environment() -> None:
    """Builds the environment if needed, then re-runs this file inside it.

    Handing over to a separate interpreter rather than importing across them:
    the app then runs under the environment's own Python, with nothing of the
    outer one's import state carried in.

    Through subprocess and not os.execv. On Windows os.exec* goes through the
    MS C runtime, which flattens the argument list into one string for the child
    to re-parse, so any argument containing a space is torn apart -- a path like
    C:\My Things\School\Rocket Club\... reaches the child as three arguments
    and it opens none of them. subprocess quotes properly on every platform.
    """
    import subprocess

    import bootstrap

    python = bootstrap.ensure(ROOT, assume_yes="--yes" in sys.argv or "-y" in sys.argv)
    # Compared by prefix, not by resolving the paths: a venv's bin/python is a
    # symlink to the interpreter it was built from, so resolve() makes the two
    # look like the same file and the handover never happens.
    if sys.prefix == str(ROOT / ".venv"):
        raise SystemExit("The environment is built but still incomplete.")
    print("\n  Starting under {}\n".format(os.path.relpath(python, ROOT)))
    sys.stdout.flush()
    command = [str(python), str(ROOT / "app.py")] + [
        a for a in sys.argv[1:] if a not in ("--yes", "-y")]
    try:
        raise SystemExit(subprocess.run(command).returncode)
    except KeyboardInterrupt:
        raise SystemExit(0)


def open_browser(url: str) -> None:
    """Opens the app, quietly falling back to whatever the platform offers.

    webbrowser.open returns False rather than raising when it cannot find a
    browser, and on Windows it can fail outright from a process started by
    another process. Either way the server is running and the address is on
    screen, so a failure here is worth nothing more than silence.
    """
    try:
        if webbrowser.open(url):
            return
    except Exception:
        pass
    try:
        if os.name == "nt":
            os.startfile(url)                                    # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    except Exception:
        pass


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def main() -> None:
    import uvicorn

    url = "http://{}:{}".format(HOST, PORT)

    # Checked before starting, because uvicorn's failure to bind is a traceback
    # about an address, which reads as the app being broken rather than as
    # another copy of it already running.
    if not port_is_free(HOST, PORT):
        raise SystemExit(
            "\n  Something is already using port {}.\n"
            "  It is probably this app, already running -- open {} and see.\n"
            "  If not, close whatever is using the port and try again.\n".format(
                PORT, url))

    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, open_browser, args=(url,)).start()

    print("\n  Lior's Really Good™ Rocket Optimizer is running.\n"
          "\n"
          "      {}\n"
          "\n"
          "  Your browser should open there by itself. If it does not, copy that\n"
          "  address into it -- the app is running either way.\n"
          "\n"
          "  Leave this window open while you use it. Ctrl-C here stops the app.\n"
          .format(url))
    # Flushed so the address is on screen before uvicorn starts: stdout is
    # block-buffered when the output is piped or captured, and a library
    # warning on unbuffered stderr would otherwise print above it.
    sys.stdout.flush()
    uvicorn.run("app.server:app", host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    if not ready():
        relaunch_in_environment()
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
