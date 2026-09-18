#!/usr/bin/env python
"""Builds the desktop app: vendor prep, PyInstaller, a smoke run, then a zip.

Run the same way locally and in .github/workflows/release.yml, so there is
one place that knows how a release actually gets made.

    python scripts/build_desktop.py [--tag v1.0.0]

Needs requirements.txt and requirements-desktop.txt installed already; it
does not create a venv.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

APP_NAME = "Rocket Optimizer"
ZIP_STEM = "RocketOptimizer"


def _version() -> str:
    from rocketopt import __version__
    return __version__


def _platform_label() -> str:
    """Matches a build to the machine it will run on, for the zip's name."""
    if sys.platform == "darwin":
        arch = {"arm64": "arm64", "x86_64": "x64"}.get(
            platform.machine(), platform.machine())
        return "macos-{}".format(arch)
    if os.name == "nt":
        arch = {"AMD64": "x64", "ARM64": "arm64"}.get(
            platform.machine(), platform.machine())
        return "windows-{}".format(arch)
    return "{}-{}".format(sys.platform, platform.machine())


def _check_tag(tag: str) -> None:
    """A zip must never claim a version it does not contain."""
    expected = "v" + _version()
    if tag != expected:
        raise SystemExit(
            "Tag {!r} does not match rocketopt.__version__ ({!r}). Update "
            "src/rocketopt/__init__.py, or push the matching tag.".format(
                tag, expected))


def _prepare_vendor() -> None:
    print("\n==> Preparing the openMotor vendor tree\n")
    import bootstrap
    bootstrap.vendor_only(ROOT)


def _run_pyinstaller() -> None:
    print("\n==> Building with PyInstaller\n")
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
         "desktop.spec"],
        cwd=str(ROOT), check=True)


def _built_binary() -> Path:
    if sys.platform == "darwin":
        return (ROOT / "dist" / (APP_NAME + ".app") / "Contents" / "MacOS"
                / APP_NAME)
    if os.name == "nt":
        return ROOT / "dist" / APP_NAME / (APP_NAME + ".exe")
    return ROOT / "dist" / APP_NAME / APP_NAME


def _smoke_test(binary: Path) -> None:
    """Proves the frozen build actually runs, not just that it compiled."""
    print("\n==> Smoke-testing the built binary\n")
    from app import paths
    from tests.sample_motor import write as write_sample_motor

    with tempfile.TemporaryDirectory(prefix="rocketopt-smoke-") as home:
        write_sample_motor(ROOT, Path(home) / "motor" / "sample.ric")
        env = dict(os.environ, ROCKETOPT_HOME=home)
        result = subprocess.run([str(binary), "--smoke"], env=env,
                                capture_output=True, text=True, timeout=300)
        log = Path(home) / paths.LOG_FILE.relative_to(paths.DATA_DIR)
        tail = log.read_text()[-4000:] if log.exists() else ""
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr)
            print(tail)
            raise SystemExit(
                "Smoke test failed (exit {}).".format(result.returncode))
        last = tail.strip().splitlines()[-1] if tail.strip() else "ok"
        print("  " + last)


def _zip_build(label: str) -> Path:
    dist = ROOT / "dist"
    out = dist / "{}-{}-{}.zip".format(ZIP_STEM, _version(), label)
    out.unlink(missing_ok=True)
    if sys.platform == "darwin":
        # ditto, not shutil, so the .app bundle's structure (and the code
        # signature PyInstaller already applied) survives the zip intact.
        bundle = dist / (APP_NAME + ".app")
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(bundle),
                        str(out)], check=True)
    else:
        shutil.make_archive(str(out.with_suffix("")), "zip",
                            root_dir=str(dist), base_dir=APP_NAME)
    print("\n==> Wrote {}\n".format(out))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tag", help="The tag this build must match, e.g. v1.0.0")
    args = parser.parse_args()

    if args.tag:
        _check_tag(args.tag)

    _prepare_vendor()
    _run_pyinstaller()
    binary = _built_binary()
    if not binary.exists():
        raise SystemExit(
            "Expected build output at {}, found nothing.".format(binary))
    _smoke_test(binary)
    _zip_build(_platform_label())


if __name__ == "__main__":
    main()
