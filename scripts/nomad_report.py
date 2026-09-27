"""Turn a Nomad Loop Engine run folder (run.json) into data/nomad-report.json for both dashboards.

usage: python scripts/nomad_report.py <run-dir> <target-url> <commit> <duration-seconds>
Keeps a rolling history of earlier scans from the previous report.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

SEV = {"minor": 1, "major": 2, "critical": 3}


def main(run_dir: str, url: str, commit: str, dur: str) -> None:
    run = json.loads((Path(run_dir) / "run.json").read_text())
    out = Path("data/nomad-report.json")
    prev = json.loads(out.read_text()) if out.exists() else {}
    bugs = [{k: b.get(k) for k in ("id", "title", "type", "severity", "status", "confirmations", "foundAtStep", "url", "message", "steps")}
            for b in run.get("bugs", [])]
    blocking = [b for b in bugs if b["status"] == "confirmed" and SEV.get(b["severity"], 0) >= SEV["major"]]
    s = run.get("stats", {})
    origin = urlparse(url).netloc
    walled = any(urlparse(b.get("url") or url).netloc not in ("", origin) for b in bugs if (b.get("foundAtStep") or 0) == 0)
    if not s.get("steps") or walled:
        # Nomad never got past the first page (auth wall, redirect off-site, site down): not a QA result.
        print(f"scan did not reach {url} (steps={s.get('steps')}, off-site={walled}); report not published")
        sys.exit(1)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    verdict = "blocked" if blocking else "ship"
    entry = {"run_id": run.get("runId", now), "finished": now, "verdict": verdict, "steps": s.get("steps", 0),
             "states": s.get("states", 0), "bugs": len(bugs), "duration_s": round(float(dur or 0)), "commit": commit}
    history = (prev.get("history") or [])[-59:] + [entry]
    report = {"status": "complete", "run_id": entry["run_id"], "finished": now, "target_url": url, "commit": commit,
              "verdict": verdict, "duration_s": entry["duration_s"], "stats": s, "bugs": bugs, "history": history}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    Path("site/data").mkdir(parents=True, exist_ok=True)
    Path("site/data/nomad.json").write_text(json.dumps(report, separators=(",", ":")))
    print(f"verdict={verdict} bugs={len(bugs)} blocking={len(blocking)} states={s.get('states')} steps={s.get('steps')}")
    sys.exit(1 if blocking else 0)


if __name__ == "__main__":
    main(*sys.argv[1:5])
