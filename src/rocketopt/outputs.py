"""What the last optimisation left behind.

``outputs/`` mirrors the most recent run and nothing else, emptied and rewritten
every time so no file in it describes a motor other than the current one.
Nothing here is source.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence


from .design import DesignSpace
from .ric import save_ric
from .runner import motor_for
from .spec import MAX_DESIGNS

#: Written on every rewrite so it is obvious the folder is disposable.
README = """This folder is the output of the last optimisation, and only the last one.

It is emptied and rewritten every time the optimiser runs. Nothing in here is
source, nothing in here is committed, and nothing in here is worth editing --
run the optimiser again and it all comes back, describing whatever motor you
ran it on.

  result.json   the whole run: spec, limits, every legal design, statistics
  motors/       one .ric per legal design, ready to open in openMotor
  figures/      the figures from the report
"""


def _empty(folder: Path) -> None:
    """Removes the contents, keeps the folder open for anything holding it."""
    for child in folder.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def write_run(result, base_motor: Dict, space: Optional[DesignSpace],
              out_dir: Path, figures: Optional[Dict[str, Path]] = None) -> List[Path]:
    """Replaces everything in ``out_dir`` with this run's data."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _empty(out_dir)

    written: List[Path] = []
    (out_dir / "README.txt").write_text(README)
    written.append(out_dir / "README.txt")

    payload = result.to_dict() if hasattr(result, "to_dict") else dict(result)
    path = out_dir / "result.json"
    path.write_text(json.dumps(payload, indent=2))
    written.append(path)

    designs = payload.get("designs", [])
    if designs and space is not None:
        motors = out_dir / "motors"
        motors.mkdir(exist_ok=True)
        for index, design in enumerate(designs):
            x = design.get("x")
            if not x:
                continue
            target = motors / ric_name(design, index)
            try:
                save_ric(target, motor_for(design, space))
                written.append(target)
            except Exception:
                # One design failing to serialise must not cost the rest.
                continue

    if figures:
        folder = out_dir / "figures"
        folder.mkdir(exist_ok=True)
        for key, source in figures.items():
            if source is None or not Path(source).exists():
                continue
            target = folder / "{}{}".format(key, Path(source).suffix)
            shutil.copyfile(source, target)
            written.append(target)

    return written


def ric_name(design: Dict, index: int) -> str:
    name = "".join(c for c in str(design.get("designation", ""))
                   if c.isalnum()) or "design"
    return "{:02d}-{}.ric".format(index + 1, name)


def build_ric_bundle(designs: Sequence[Dict], space: DesignSpace, out_path: Path,
                     on_progress: Callable[[int, int, str], None] = lambda *a: None
                     ) -> Path:
    """Zips one ``.ric`` per design at ``out_path``. No simulation: a design
    already carries its motor, so this is fast."""
    designs = list(designs)[:MAX_DESIGNS]
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not any(d.get("x") for d in designs):
        raise ValueError("That run found no legal designs.")
    total = len(designs)
    with tempfile.TemporaryDirectory() as folder, \
            zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        # Numbered as the options table is, so a file matches its row.
        for index, design in enumerate(designs):
            if not design.get("x"):
                continue
            name = ric_name(design, index)
            target = save_ric(Path(folder) / name, motor_for(design, space))
            archive.write(target, name)
            on_progress(index + 1, total, "Wrote {} of {}".format(index + 1, total))
    return out_path
