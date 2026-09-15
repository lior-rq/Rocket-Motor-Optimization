#!/usr/bin/env python
"""Starts Lior's Really Good™ Rocket Optimizer as a desktop app.

This is the frozen build's entry point: a native window instead of a
browser tab, with no server address to see or copy. ``app.py`` is the
source/browser entry point and is unaffected by this file.
"""
import multiprocessing
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

if __name__ == "__main__":
    # Must be the first thing that runs: a frozen build's worker processes
    # re-execute this file under spawn, and without this they would each try
    # to open another window instead of just evaluating a design.
    multiprocessing.freeze_support()

    from app.desktop import main

    main()
