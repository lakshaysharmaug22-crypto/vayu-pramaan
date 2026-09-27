"""Stage runner: every pipeline step runs through here so each run leaves a manifest.

A manifest records, per stage and sub-step: rows in/out, checks, freshness and timing.
The site's Pipeline section is drawn entirely from these manifests.
"""
from __future__ import annotations

import json
import time
import traceback
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

from .config import DATA

RUNS_DIR = DATA / "runs"
RUNS_DIR.mkdir(parents=True, exist_ok=True)

STAGES = ["ingest", "validate", "transform", "features", "model", "ledger", "insights", "export"]


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""
    severity: str = "error"  # error blocks the run, warn does not


@dataclass
class StepResult:
    stage: str
    step: str
    status: str = "ok"          # ok | warn | failed | skipped
    rows_in: int | None = None
    rows_out: int | None = None
    duration_s: float = 0.0
    freshness: str | None = None  # latest timestamp in the output
    checks: list[Check] = field(default_factory=list)
    notes: str = ""
    error: str | None = None


class Run:
    def __init__(self, mode: str = "daily"):
        now = datetime.now(timezone.utc)
        self.run_id = now.strftime("%Y%m%dT%H%M%SZ")
        self.mode = mode
        self.started = now.isoformat()
        self.steps: list[StepResult] = []

    def step(self, stage: str, step: str):
        assert stage in STAGES, stage
        return _StepCtx(self, stage, step)

    @property
    def failed(self) -> bool:
        return any(s.status == "failed" for s in self.steps)

    def summary(self) -> dict:
        by_stage = {}
        for st in STAGES:
            ss = [s for s in self.steps if s.stage == st]
            if not ss:
                continue
            status = "failed" if any(s.status == "failed" for s in ss) else \
                     "warn" if any(s.status == "warn" for s in ss) else "ok"
            by_stage[st] = {
                "status": status,
                "duration_s": round(sum(s.duration_s for s in ss), 2),
                "rows_out": int(sum(int(s.rows_out or 0) for s in ss)),
                "checks_total": sum(len(s.checks) for s in ss),
                "checks_passed": sum(c.passed for s in ss for c in s.checks),
            }
        return by_stage

    def save(self) -> dict:
        doc = {
            "run_id": self.run_id, "mode": self.mode, "started": self.started,
            "finished": datetime.now(timezone.utc).isoformat(),
            "status": "failed" if self.failed else "ok",
            "stages": self.summary(),
            "steps": [{**asdict(s), "checks": [asdict(c) for c in s.checks]} for s in self.steps],
        }
        (RUNS_DIR / f"run_{self.run_id}.json").write_text(json.dumps(doc, indent=2, default=str))
        return doc


class _StepCtx:
    def __init__(self, run: Run, stage: str, step: str):
        self.run, self.res = run, StepResult(stage=stage, step=step)

    def __enter__(self) -> StepResult:
        self.t0 = time.perf_counter()
        print(f"[{self.res.stage:>9}] {self.res.step} …", flush=True)
        return self.res

    def __exit__(self, exc_type, exc, tb):
        r = self.res
        r.duration_s = round(time.perf_counter() - self.t0, 3)
        if exc is not None:
            r.status, r.error = "failed", f"{exc_type.__name__}: {exc}"
            traceback.print_exception(exc_type, exc, tb)
        elif r.status == "ok":
            bad = [c for c in r.checks if not c.passed]
            if any(c.severity == "error" for c in bad):
                r.status = "failed"
            elif bad:
                r.status = "warn"
        self.run.steps.append(r)
        print(f"[{r.stage:>9}] {r.step} → {r.status} "
              f"({r.rows_out if r.rows_out is not None else '-'} rows, {r.duration_s}s)", flush=True)
        return True  # never crash the whole run; the manifest records the failure
