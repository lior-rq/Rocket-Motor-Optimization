#!/usr/bin/env python
"""Builds the desktop app's .icns and .ico from icons/app-icon.png.

Run again after replacing that file:
    python scripts/build_icon.py
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
SOURCE = ICONS / "app-icon.png"

#: (name inside the .iconset, pixel size). Apple's required set for iconutil.
ICNS_SIZES = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def build_icns(source: Image.Image) -> None:
    if shutil.which("iconutil") is None:
        print("  iconutil not found (macOS only); skipping .icns")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "app-icon.iconset"
        iconset.mkdir()
        for name, size in ICNS_SIZES:
            source.resize((size, size), Image.LANCZOS).save(iconset / (name + ".png"))
        subprocess.run(["iconutil", "-c", "icns", str(iconset),
                        "-o", str(ICONS / "app-icon.icns")], check=True)
    print("  wrote icons/app-icon.icns")


def build_ico(source: Image.Image) -> None:
    source.save(ICONS / "app-icon.ico", sizes=[(s, s) for s in ICO_SIZES])
    print("  wrote icons/app-icon.ico")


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit("Expected a square source image at {}".format(SOURCE))
    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        raise SystemExit("icons/app-icon.png must be square ({}x{} given)".format(
            source.width, source.height))
    build_icns(source)
    build_ico(source)


if __name__ == "__main__":
    main()
