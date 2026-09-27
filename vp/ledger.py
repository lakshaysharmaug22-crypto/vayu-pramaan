"""Stage 6 · Ledger. Every forecast is hashed, rolled into a Merkle root, and chained to the
previous run before any outcome exists. `verify()` re-derives the whole chain from files.

Layout:
  ledger/entries/YYYY-MM-DD.jsonl   one canonical JSON forecast per line (ours + CAMS)
  ledger/chain.jsonl                one block per run: date, n, merkle root, prev root, block hash
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from . import config as C

ENTRIES = C.LEDGER_DIR / "entries"
CHAIN = C.LEDGER_DIR / "chain.jsonl"
ENTRIES.mkdir(parents=True, exist_ok=True)
GENESIS = "0" * 64


def use_dir(root):
    """Point the ledger somewhere else (synthetic runs never touch the real ledger)."""
    global ENTRIES, CHAIN
    ENTRIES, CHAIN = root / "entries", root / "chain.jsonl"
    ENTRIES.mkdir(parents=True, exist_ok=True)


def canon(row: dict) -> str:
    def norm(v):
        if isinstance(v, float):
            return round(v, 3)
        if isinstance(v, (pd.Timestamp, datetime)):
            return v.strftime("%Y-%m-%d")
        return v
    return json.dumps({k: norm(v) for k, v in sorted(row.items())}, sort_keys=True, separators=(",", ":"))


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def merkle(hashes: list[str]) -> str:
    if not hashes:
        return sha("")
    level = list(hashes)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [sha(a + b) for a, b in zip(level[::2], level[1::2])]
    return level[0]


def merkle_proof(hashes: list[str], idx: int) -> list[tuple[str, str]]:
    proof, level = [], list(hashes)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        sib = idx ^ 1
        proof.append(("L" if sib < idx else "R", level[sib]))
        level = [sha(a + b) for a, b in zip(level[::2], level[1::2])]
        idx //= 2
    return proof


def _chain() -> list[dict]:
    if not CHAIN.exists():
        return []
    return [json.loads(l) for l in CHAIN.read_text().splitlines() if l.strip()]


def entries_for(run_date: str) -> list[dict]:
    p = ENTRIES / f"{run_date}.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def today_ist() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")


def commit(rows: list[dict], run_date: str, model_version: str) -> dict:
    """Append one block. Refuses to rewrite a date that is already committed."""
    chain = _chain()
    today = today_ist()
    late = [r for r in rows if str(r["target_date"])[:10] <= today]
    if late:
        raise RuntimeError(f"refusing to commit {len(late)} row(s) for dates that are not in the future ({today} IST)")
    if any(b["run_date"] == run_date for b in chain):
        raise RuntimeError(f"{run_date} already committed; the ledger is append-only")
    path = ENTRIES / f"{run_date}.jsonl"
    lines = [canon(r | {"model_version": model_version}) for r in rows]
    path.write_text("\n".join(lines) + "\n")
    hashes = [sha(l) for l in lines]
    prev = chain[-1]["block_hash"] if chain else GENESIS
    block = {"height": len(chain), "run_date": run_date, "n": len(lines), "root": merkle(hashes),
             "prev": prev, "file_sha256": sha(path.read_text()),
             "committed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    block["block_hash"] = sha(canon({k: v for k, v in block.items() if k != "committed_at"}))
    with CHAIN.open("a") as f:
        f.write(json.dumps(block) + "\n")
    return block


def verify() -> dict:
    chain, prev, problems = _chain(), GENESIS, []
    for b in chain:
        p = ENTRIES / f"{b['run_date']}.jsonl"
        if not p.exists():
            problems.append(f"{b['run_date']}: entries file missing"); continue
        lines = [l for l in p.read_text().splitlines() if l.strip()]
        if merkle([sha(l) for l in lines]) != b["root"]:
            problems.append(f"{b['run_date']}: merkle root mismatch (entries edited)")
        if b["prev"] != prev:
            problems.append(f"{b['run_date']}: broken link to previous block")
        recomputed = sha(canon({k: v for k, v in b.items() if k not in ("committed_at", "block_hash")}))
        if recomputed != b["block_hash"]:
            problems.append(f"{b['run_date']}: block header edited")
        prev = b["block_hash"]
    return {"blocks": len(chain), "ok": not problems, "problems": problems,
            "head": chain[-1]["block_hash"] if chain else None}


def load_entries() -> pd.DataFrame:
    files = sorted(ENTRIES.glob("*.jsonl"))
    rows = [json.loads(l) for f in files for l in f.read_text().splitlines() if l.strip()]
    return pd.DataFrame(rows)


def proofs_for_site(limit_blocks: int = 30) -> list[dict]:
    """Recent blocks with each entry's hash + Merkle proof, so the site can verify in the browser."""
    out = []
    for b in _chain()[-limit_blocks:]:
        p = ENTRIES / f"{b['run_date']}.jsonl"
        lines = [l for l in p.read_text().splitlines() if l.strip()] if p.exists() else []
        hashes = [sha(l) for l in lines]
        out.append(b | {"entries": [{"line": l, "hash": h, "proof": merkle_proof(hashes, i)}
                                    for i, (l, h) in enumerate(zip(lines, hashes))]})
    return out


def grade(con) -> pd.DataFrame:
    """Join committed forecasts to settled truth (≥ 2 days old, CPCB data gets revised)."""
    e = load_entries()
    if not len(e):
        return pd.DataFrame()
    con.register("ledger_entries", e)
    return con.execute("""
        select l.source, l.issue_date::date issue_date, l.target_date::date target_date, l.horizon_h,
               l.p10, l.p50, l.p90, l.p_severe, a.aqi actual,
               abs(l.p50 - a.aqi) abs_err, (a.aqi between l.p10 and l.p90) in_band,
               a.aqi > 400 severe, l.p_severe >= 0.5 warned
        from ledger_entries l join aqi_daily a on a.date = l.target_date::date
        where l.target_date::date <= current_date - 2
        order by target_date, source, horizon_h""").df()
