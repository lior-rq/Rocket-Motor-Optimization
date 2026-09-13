"""Background optimisation runs and their progress.

A run takes minutes, too long to hold an HTTP request open, so each becomes a
job with an id that the browser polls. The heavy work is already in child
processes, so a thread here is enough.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from rocketopt.bundle import build_bundle
from rocketopt.outputs import write_run
from rocketopt.report import ReportRun, build_report
from rocketopt.runner import RunResult, run
from rocketopt.spec import RunSpec


def describe_spec(spec: RunSpec) -> str:
    """A short name for what a run was allowed to move."""
    free = [v.name for v in spec.variables if v.free]
    cores = sum(1 for n in free if n.startswith("core"))
    nozzle = [n for n in free if not n.startswith("core")]
    gc = spec.grain_count
    counts = ", {}-{} grains".format(gc.n_min, gc.n_max) if gc.free else ""
    if cores and not nozzle:
        return "Cores only, nozzle fixed" + counts
    if cores and nozzle:
        return "Cores plus {} nozzle dimension{}{}".format(
            len(nozzle), "" if len(nozzle) == 1 else "s", counts)
    if nozzle:
        return "Nozzle only" + counts
    return "No free dimensions" + counts


@dataclass
class Job:
    id: str
    status: str = "queued"          # queued | running | done | failed | cancelled
    stage: str = "queued"
    fraction: float = 0.0
    message: str = "Waiting to start"
    error: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    result: Optional[RunResult] = None
    spec: Optional[RunSpec] = None
    label: str = ""
    #: Latest generation snapshot. Replaced, not appended, so the poll payload
    #: stays a fixed size.
    telemetry: Optional[Dict] = None
    trace: List[Dict] = field(default_factory=list)
    #: Simulations counted at the last snapshot, for the live speed reading.
    _last_count: int = 0
    _last_time: float = 0.0
    rate: float = 0.0
    #: What the estimate promised, so the registry can learn its own error.
    predicted: float = 0.0
    shape: str = ""
    #: The report for this run, written as soon as it finishes.
    report: Optional[Path] = None
    report_error: str = ""
    #: One sheet per design, zipped. On request only: a browser launch each.
    bundle: Optional[Path] = None
    #: "sheets" for the per-design PDFs, "eng" for the RASP motor files. One
    #: at a time: both are heavy, and the screen only shows one progress bar.
    bundle_kind: str = "sheets"
    bundle_status: str = "idle"      # idle | building | ready | failed
    bundle_done: int = 0
    bundle_total: int = 0
    bundle_message: str = ""
    bundle_error: str = ""
    _cancel: threading.Event = field(default_factory=threading.Event)

    def status_dict(self) -> Dict:
        elapsed = (self.finished_at or time.time()) - self.started_at
        return {
            "report": self.report.name if self.report else "",
            "report_error": self.report_error,
            "bundle_kind": self.bundle_kind,
            "bundle_status": self.bundle_status,
            "bundle_done": self.bundle_done,
            "bundle_total": self.bundle_total,
            "bundle_message": self.bundle_message,
            "bundle_error": self.bundle_error,
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "fraction": round(self.fraction, 4),
            "message": self.message,
            "error": self.error,
            "elapsed": round(elapsed, 1),
            "label": self.label,
            "n_designs": len(self.result.designs) if self.result else 0,
        }


class JobRegistry:
    """Holds running and recently finished jobs, newest kept."""

    def __init__(self, keep: int = 12) -> None:
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._lock = threading.Lock()
        self.keep = keep
        #: How wrong the estimate was, per kind of run. Non-simulation costs
        #: differ by mode, so the correction is learned rather than constant.
        self._factors: Dict[str, float] = {}

    def factor(self, shape: str) -> float:
        return self._factors.get(shape, 1.0)

    def has_seen(self, shape: str) -> bool:
        """Whether a run of this kind has finished and taught us its cost."""
        return shape in self._factors

    def record_outcome(self, shape: str, predicted: float, actual: float) -> None:
        """Folds one run's accuracy into the correction for its shape.

        Smoothed, so one run under load does not overcorrect the next estimate.
        """
        if not predicted or predicted <= 0 or actual <= 0:
            return
        observed = actual / predicted
        previous = self._factors.get(shape)
        blended = observed if previous is None else 0.5 * previous + 0.5 * observed
        self._factors[shape] = float(min(max(blended, 0.2), 5.0))

    def start_bundle(self, job: Job, base_motor: Dict, out_dir: Path,
                     kind: str = "sheets", workers: Optional[int] = None) -> bool:
        """Builds the per-design download. Never inline: the sheets launch a
        browser each and the .eng files are a full simulation each."""
        if job.result is None or job.status != "done":
            return False
        if job.bundle_status == "building":
            return True

        job.bundle_kind = kind
        job.bundle = None
        job.bundle_status = "building"
        job.bundle_done, job.bundle_total = 0, len(job.result.designs)
        job.bundle_message = "Starting"
        job.bundle_error = ""

        def progress(done: int, total: int, message: str) -> None:
            job.bundle_done, job.bundle_total = done, total
            job.bundle_message = message

        def target() -> None:
            try:
                if kind == "eng":
                    from rocketopt.eng import build_eng_bundle
                    from rocketopt.runner import build_space

                    out = out_dir / "eng-files-{}.zip".format(job.id)
                    job.bundle = build_eng_bundle(
                        job.result.designs, build_space(job.spec, base_motor),
                        base_motor, out, on_progress=progress, workers=workers)
                else:
                    out = out_dir / "design-sheets-{}.zip".format(job.id)
                    job.bundle = build_bundle(
                        ReportRun(label=job.label, result=job.result.to_dict(),
                                  spec=job.spec),
                        base_motor, out, on_progress=progress)
                job.bundle_status = "ready"
                job.bundle_message = "Ready"
            except Exception as exc:
                job.bundle_status = "failed"
                job.bundle_error = str(exc)
                job.bundle_message = ("Could not write the .eng files" if kind == "eng"
                                      else "Could not build the sheets")
                traceback.print_exc()

        threading.Thread(target=target, name="bundle-" + job.id,
                         daemon=True).start()
        return True

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def listing(self) -> List[Dict]:
        """Newest first, so the report picker shows the latest run at the top."""
        with self._lock:
            return [self._jobs[i].status_dict()
                    for i in reversed(self._order) if i in self._jobs]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status in ("done", "failed", "cancelled"):
            return False
        job._cancel.set()
        job.status = "cancelled"
        job.message = "Cancelled"
        job.finished_at = time.time()
        return True

    def start(self, spec: RunSpec, base_motor: Dict, workers: Optional[int] = None,
              predicted: float = 0.0, shape: str = "",
              reports_dir: Optional[Path] = None,
              outputs_dir: Optional[Path] = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], spec=spec,
                  label=describe_spec(spec))
        job.predicted = float(predicted)
        job.shape = shape
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            while len(self._order) > self.keep:
                self._jobs.pop(self._order.pop(0), None)

        budget = spec.budget

        def telemetry(snapshot: Dict) -> None:
            # The runner counts across every grain count and stage it plans;
            # older snapshots without a count follow the budget's grid.
            if snapshot.get("simulations_done") is None:
                snapshot["simulations_done"] = (
                    (snapshot["seed_index"] * budget["gen"]
                     + snapshot["generation"]) * budget["pop"])
                snapshot["simulations_total"] = budget["total"]
            done = snapshot["simulations_done"]
            now = time.time()
            if job._last_time and now > job._last_time and done > job._last_count:
                sample = (done - job._last_count) / (now - job._last_time)
                # Smoothed: one slow generation should not swing the reading.
                job.rate = sample if not job.rate else 0.7 * job.rate + 0.3 * sample
            job._last_count, job._last_time = done, now
            snapshot["rate"] = round(job.rate, 2)
            snapshot["workers"] = workers or 0
            history = job.trace
            best = snapshot.get("best")
            if best is not None:
                history.append({"seed": snapshot["seed_index"],
                                "gen": snapshot["generation"],
                                "a": best[0], "b": best[1]})
                # Thin the oldest half; no sparkline shows thousands of points.
                if len(history) > 600:
                    del history[: len(history) // 2]
            snapshot["trace"] = history[-240:]
            job.telemetry = snapshot

        def progress(stage: str, fraction: float, message: str) -> None:
            if job._cancel.is_set():
                # The optimiser has no cancel hook; raising here is the way out.
                raise RuntimeError("__cancelled__")
            job.stage, job.fraction, job.message = stage, fraction, message

        def target() -> None:
            job.status = "running"
            try:
                job.result = run(spec, base_motor, on_progress=progress,
                                 workers=workers, on_telemetry=telemetry)
                # A failed report must not lose the run that produced it.
                if reports_dir is not None or outputs_dir is not None:
                    job.stage, job.fraction = "report", 0.97
                    job.message = "Writing the report"
                    try:
                        # outputs/ mirrors the last run only, so empty it first.
                        figures_dir = None
                        if outputs_dir is not None:
                            from rocketopt.runner import build_space
                            write_run(job.result, base_motor,
                                      build_space(spec, base_motor), outputs_dir)
                            figures_dir = Path(outputs_dir) / "figures"
                        if reports_dir is not None:
                            files = build_report(
                                [ReportRun(label=job.label,
                                           result=job.result.to_dict(), spec=spec)],
                                base_motor, reports_dir, figures_dir=figures_dir)
                            job.report = files.path
                            job.report_error = files.pdf_error
                    except Exception as exc:
                        job.report_error = str(exc)
                        traceback.print_exc()
                job.status, job.stage, job.fraction = "done", "done", 1.0
                job.message = "Finished"
                # The only correction loop; see _rate_at in server.py.
                self.record_outcome(job.shape, job.predicted,
                                    time.time() - job.started_at)
            except Exception as exc:  # surfaced to the user, not swallowed
                if "__cancelled__" in str(exc):
                    job.status, job.message = "cancelled", "Cancelled"
                else:
                    job.status = "failed"
                    job.error = str(exc)
                    job.message = "Run failed"
                    traceback.print_exc()
            finally:
                job.finished_at = time.time()

        threading.Thread(target=target, name="optimise-" + job.id,
                         daemon=True).start()
        return job
