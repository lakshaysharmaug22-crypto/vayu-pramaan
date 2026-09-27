"""Core guarantees: the ledger detects tampering, the agent guard blocks unsafe SQL,
AQI sub-indices match CPCB breakpoints."""
import json
import shutil

import duckdb
import pytest

from vp import agent, ledger, warehouse


@pytest.fixture()
def tmp_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "ENTRIES", tmp_path / "entries")
    monkeypatch.setattr(ledger, "CHAIN", tmp_path / "chain.jsonl")
    (tmp_path / "entries").mkdir()
    return tmp_path


def rows(d):
    return [{"source": "vayu", "issue_date": d, "target_date": d, "horizon_h": h, "p10": 300.0, "p50": 350.0 + h,
             "p90": 420.0, "p_severe": 0.2} for h in (24, 48, 72)]


def test_chain_verifies(tmp_ledger):
    for d in ("2026-10-01", "2026-10-02", "2026-10-03"):
        ledger.commit(rows(d), d, "abc123")
    v = ledger.verify()
    assert v["ok"] and v["blocks"] == 3


def test_append_only(tmp_ledger):
    ledger.commit(rows("2026-10-01"), "2026-10-01", "x")
    with pytest.raises(RuntimeError):
        ledger.commit(rows("2026-10-01"), "2026-10-01", "x")


def test_edit_entry_detected(tmp_ledger):
    for d in ("2026-10-01", "2026-10-02"):
        ledger.commit(rows(d), d, "x")
    p = tmp_ledger / "entries" / "2026-10-01.jsonl"
    p.write_text(p.read_text().replace('"p50":374', '"p50":300'))
    v = ledger.verify()
    assert not v["ok"] and any("merkle" in x for x in v["problems"])


def test_rewrite_block_detected(tmp_ledger):
    for d in ("2026-10-01", "2026-10-02"):
        ledger.commit(rows(d), d, "x")
    blocks = [json.loads(l) for l in (tmp_ledger / "chain.jsonl").read_text().splitlines()]
    blocks[0]["n"] = 99
    (tmp_ledger / "chain.jsonl").write_text("\n".join(json.dumps(b) for b in blocks) + "\n")
    assert not ledger.verify()["ok"]


def test_merkle_proof_roundtrip():
    hs = [ledger.sha(str(i)) for i in range(7)]
    root = ledger.merkle(hs)
    for i, h in enumerate(hs):
        acc = h
        for side, sib in ledger.merkle_proof(hs, i):
            acc = ledger.sha(sib + acc) if side == "L" else ledger.sha(acc + sib)
        assert acc == root


@pytest.mark.parametrize("sql", [
    "drop table aqi_daily", "select 1; drop table x", "select * from raw_aqi",
    "select * from read_csv('/etc/passwd')", "copy v_aqi_daily to 'x.csv'", "update v_aqi_daily set aqi=1"])
def test_guard_blocks(sql):
    with pytest.raises(ValueError):
        agent.guard(sql)


def test_guard_allows_views_and_ctes():
    g = agent.guard("with s as (select date, aqi from v_aqi_daily) select * from s join v_wind_daily w using (date)")
    assert g.endswith("limit 1000")


@pytest.mark.parametrize("pm25,expected", [(30, 50), (60, 100), (90, 200), (120, 300), (250, 400)])
def test_cpcb_pm25_breakpoints(pm25, expected):
    con = duckdb.connect()
    con.execute(warehouse.MACROS)
    assert round(con.execute(f"select si_pm25({pm25})").fetchone()[0]) == expected
