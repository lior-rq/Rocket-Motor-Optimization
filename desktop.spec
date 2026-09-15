# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the desktop build.

Run via scripts/build_desktop.py, which prepares the openMotor vendor tree
first (see bootstrap.py:prepare_vendor). Direct use:
    pyinstaller --noconfirm --clean desktop.spec
"""

import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

sys.path.insert(0, "src")
from rocketopt import __version__ as ROCKETOPT_VERSION

block_cipher = None

hiddenimports = (
    [
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "motorlib",
        "mathlib",
        "skfmm",
        "threadpoolctl",
    ]
    # pymoo picks its algorithms/operators up by string lookup in a few
    # places, so static analysis alone can miss some. Its autograd backend
    # (pymoo.gradient) is unused by this app's derivative-free NSGA2/GA runs
    # and segfaults on import in isolation (crashes the collector itself),
    # so it is filtered out here.
    + collect_submodules("pymoo", filter=lambda n: not n.startswith("pymoo.gradient"))
    + collect_submodules("skimage.draw")
)

#: Heavy or dev-only packages nothing in the desktop path imports.
excludes = [
    "pymupdf", "fitz", "plotly", "pytest", "Cython", "pyarrow",
    "tkinter", "PyQt5", "PySide2", "PySide6", "IPython", "notebook",
]

a = Analysis(
    ["desktop.py"],
    pathex=["src", "vendor/openMotor"],
    binaries=[],
    datas=[
        ("app/static", "app/static"),
        ("LICENSE", "."),
        ("vendor/openMotor/LICENSE", "licenses/openMotor"),
    ]
    # scipy's Sobol' sampler reads its direction numbers from this file at
    # import time; no contrib hook ships it, so without this the space-filling
    # sample silently falls back to a lower-quality generator (a warning, not
    # an error -- easy to miss without the smoke test).
    + collect_data_files("scipy.stats", includes=["*.npz"]),
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Rocket Optimizer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Rocket Optimizer",
)

app = BUNDLE(
    coll,
    name="Rocket Optimizer.app",
    icon=None,
    bundle_identifier="com.rebigex.rocketopt",
    info_plist={
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
        "CFBundleShortVersionString": ROCKETOPT_VERSION,
    },
)
