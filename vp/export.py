"""Stage 8 · Export. Everything the site shows is a JSON file written here."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C, ledger
from .runner import RUNS_DIR

OUT = C.SITE_DATA


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if (o != o or o in (float("inf"), float("-inf"))) else round(float(o), 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp,)):
        return o.strftime("%Y-%m-%d") if o.hour == 0 and o.minute == 0 else o.isoformat()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def _w(name: str, obj) -> int:
    (OUT / name).write_text(json.dumps(_clean(obj), separators=(",", ":")))
    return 1


def _df(df: pd.DataFrame) -> list[dict]:
    return _clean(df.astype(object).where(pd.notna(df), None).to_dict("records"))


def write_all(ctx: dict, run) -> int:
    from .warehouse import connect
    con = connect(read_only=True)
    n = 0
    fc = ctx["forecast"]
    latest = con.execute("select * from v_aqi_daily order by date desc limit 1").df()

    # overview: hero
    n += _w("overview.json", {
        "latest": _df(latest)[0] if len(latest) else None,
        "forecast": _df(fc.drop(columns=["aqi_0"], errors="ignore")),
        "explain": ctx["explain"], "importance": ctx["importance"],
        "grap_call": ctx["grap_call"], "brief": ctx["brief"],
        "synthetic": C.SYNTHETIC,
    })

    # live: last 7 days hourly + stations + fires
    n += _w("live.json", {
        "city_hourly": _df(con.execute("""select strftime(ts, '%Y-%m-%dT%H:00') ts, pm25, pm10, n_stations from aqi_hourly_city
            where ts >= (select max(ts) from aqi_hourly_city) - interval 7 day order by ts""").df()),
        "stations_latest": _df(con.execute("""select station, aqi, pm25, pm10, hours from v_station_daily
            where date = (select max(date) from v_station_daily) order by aqi desc""").df()),
        "fires_daily": _df(con.execute("""select date, fires, fires_punjab, fires_haryana, frp_sum from v_fires_upwind
            where date >= (select max(date) from v_fires_upwind) - 13 order by date""").df()),
        "fire_points": _df(con.execute("""select lat, lon, frp, state, date from raw_fires
            where date >= (select max(date) from raw_fires) - 2 using sample 1500 rows""").df()),
        "wind": _df(con.execute("select * from v_wind_daily where date >= (select max(date) from v_wind_daily) - 6 order by date").df()),
    })

    # season timelines (for the hero "play the season" + findings charts)
    n += _w("seasons.json", _df(con.execute("""
        select a.date, a.aqi, a.band, f.fires, f.fires_punjab, f.fires_haryana, w.nw_frac, w.nw_frac_upwind, w.wind_dir,
               w.wind_speed, w.blh, w.blh_min, c.aqi_equiv cams
        from v_aqi_daily a left join v_fires_upwind f using (date) left join v_wind_daily w using (date)
        left join v_cams_daily c using (date)
        where month(a.date) in (9, 10, 11, 12) order by a.date""").df()))

    # real detections for the season replay: latest Oct–Nov with fires, up to 220 per day
    yr = con.execute("select max(year(date)) from raw_fires where month(date) in (10, 11)").fetchone()[0]
    pts = con.execute(f"""select date, round(lat, 3) lat, round(lon, 3) lon, state from raw_fires
        where year(date) = {yr or 0} and month(date) in (10, 11)
        qualify row_number() over (partition by date order by hash(lat, lon)) <= 220 order by date""").df()
    n += _w("season_points.json", {"season": yr, "points": _df(pts)})
    st = con.execute(f"""select date, station, round(aqi) aqi, round(pm25, 1) pm25 from v_station_daily
        where year(date) = {yr or 0} and month(date) in (10, 11) order by date, station""").df()
    n += _w("season_stations.json", {"season": yr, "rows": _df(st)})

    bt = con.execute("select * from backtest where horizon_h = 48 order by target_date").df()
    n += _w("backtest.json", {"metrics": ctx["metrics"], "calibration": ctx["calibration"],
                              "h48": _df(bt[["target_date", "season", "actual", "p10", "p50", "p90", "p_severe",
                                             "persistence", "climatology"]]) if len(bt) else []})
    n += _w("findings.json", ctx["findings"])
    n += _w("decision.json", {"table": ctx["decision"], "call": ctx["grap_call"]})
    n += _w("agent.json", ctx["eval"])
    g = ctx.get("graded")
    n += _w("ledger.json", {"verify": ctx["verify"], "blocks": ledger.proofs_for_site(),
                            "graded": _df(g) if g is not None and len(g) else []})
    n += _w("whatif.json", ctx.get("whatif", {}))
    n += _w("arena.json", ctx.get("arena", {}))
    n += _w("drift.json", ctx.get("drift", {}))
    nomad = C.DATA / "nomad-report.json"
    n += _w("nomad.json", json.loads(nomad.read_text()) if nomad.exists() else {"status": "not_run"})
    con.close()
    return n


def write_api(ctx: dict) -> int:
    from . import extras
    from .warehouse import connect
    con = connect(read_only=True)
    ov = json.loads((OUT / "overview.json").read_text())
    cat = extras.write_api(con, ov, ctx.get("metrics", {}))
    con.close()
    _w("catalog.json", cat)
    return len(cat["datasets"])


def write_lineage(run) -> int:
    from . import extras
    from .warehouse import connect
    con = connect(read_only=True)
    lin = extras.lineage(con, run)
    con.close()
    _w("lineage.json", lin)
    return len(lin["nodes"])


def write_manifest(doc: dict):
    runs = sorted(RUNS_DIR.glob("run_*.json"))[-30:]
    history = []
    for p in runs:
        d = json.loads(p.read_text())
        history.append({"run_id": d["run_id"], "mode": d["mode"], "status": d["status"], "stages": d["stages"]})
    _w("pipeline.json", {"latest": doc, "history": history})
