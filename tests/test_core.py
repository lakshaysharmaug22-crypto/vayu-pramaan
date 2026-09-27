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


def test_psi_flags_real_shift_not_noise():
    import numpy as np
    from vp.extras import _psi
    rng = np.random.default_rng(0)
    ref = rng.normal(0, 1, 600)
    same = _psi(ref, rng.normal(0, 1, 30))
    shifted = _psi(ref, rng.normal(2.5, 1, 30))
    assert shifted > 1.0 and shifted > 4 * same


GRID = ('Year,2017\r\nJanuary-2017,' + ",".join(f"{h:02d}:00:00" for h in range(24)) + '\r\n"\n"\r\n'
        'February-2017,' + ",".join(f"{h:02d}:00:00" for h in range(24)) + '\r\n'
        '1,,,,,,,,,,,,,,,,,,,,,,,,\r\n2,,,,,,,,,,,,,,375.0,,316.0,,310.0,,220.0,,308.0,,157.0\r\n'
        '3,120.0,,98.0,,93.0,,87.0,,147.0,98.0,140.0,120.0,,64.0,,95.0,,113.0,,120.0,,150.0,180.0,167.0\r\n')


def test_cpcb_grid_parser():
    from vp.ingest import _parse_cpcb_grid
    df = _parse_cpcb_grid(GRID, "Alipur")
    assert len(df) == 6 + 15
    first = df.sort_values("ts").iloc[0]
    assert str(first.ts) == "2017-02-02 13:00:00" and first.aqi == 375.0


def test_station_names_match_across_series():
    from vp.ingest import station_key
    assert station_key("ihbas-dilshad-garden-cpcb-aqi-data-2017-2023") == station_key("ihbas-cpcb-15-minute-aqi-data-for-2024-25")
    assert station_key("okhla-phase-2-dpcc-aqi-data-2017-2023") == station_key("Okhla Phase 2 15 minute AQI Data for 2024-25")
