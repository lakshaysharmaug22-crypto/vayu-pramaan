"""Scale-up components: what-if grid, model arena, drift monitor, lineage graph, public API + catalog."""
from __future__ import annotations

import itertools
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import config as C, ledger, model
from .features import FEATURES

# ───────────── what-if ─────────────
FIRE_MULT = [0, 0.25, 0.5, 0.75, 1, 1.5, 2]
NW_LEVELS = [0, 0.25, 0.5, 0.75, 1]
BLH_MULT = [0.5, 0.75, 1, 1.25, 1.5]
FIRE_COLS = ["fires_0", "fires_1", "fires_2", "fires_sum3", "fires_trend", "frp_0"]


def whatif_grid() -> dict:
    """Re-run the live models on perturbed copies of today's inputs.

    This shows how the model responds to each lever. It is not a causal estimate: the model
    learned correlations, which the site states next to the sliders.
    """
    out = {"axes": {"fire_mult": FIRE_MULT, "nw": NW_LEVELS, "blh_mult": BLH_MULT}, "horizons": {}}
    for h, (models, x) in sorted(model.LIVE.items()):
        base = x.iloc[[0]]
        rows = []
        for fm, nw, bm in itertools.product(FIRE_MULT, NW_LEVELS, BLH_MULT):
            r = base.copy()
            for c in FIRE_COLS:
                r[c] = r[c] * fm
            r["nw_frac_0"] = nw
            r["nw_frac_upwind_0"] = nw
            r["blh_0"] = r["blh_0"] * bm
            r["blh_min_0"] = r["blh_min_0"] * bm
            rows.append(r)
        X = pd.concat(rows, ignore_index=True)
        P = model.predict(models, X)
        grid = [[FIRE_MULT.index(fm), NW_LEVELS.index(nw), BLH_MULT.index(bm), int(p.p10), int(p.p50), int(p.p90), float(p.p_severe)]
                for (fm, nw, bm), p in zip(itertools.product(FIRE_MULT, NW_LEVELS, BLH_MULT), P.itertuples())]
        b = base.iloc[0]
        out["horizons"][h] = {
            "target_date": str(b.target_date)[:10],
            "base": {"fires_0": _f(b.fires_0), "nw_frac_0": _f(b.nw_frac_0), "blh_0": _f(b.blh_0), "blh_min_0": _f(b.blh_min_0), "aqi_0": _f(b.aqi_0)},
            "grid": grid,
        }
    return out


def _f(v):
    return None if pd.isna(v) else round(float(v), 3)


# ───────────── model arena ─────────────
def arena(con, bt: pd.DataFrame) -> dict:
    if not len(bt):
        return {}
    cams = con.execute("select date, aqi_equiv from v_cams_daily").df()
    cams["date"] = pd.to_datetime(cams["date"])
    b = bt.merge(cams, left_on="target_date", right_on="date", how="left")
    contenders = [("Vayu (LightGBM quantile)", "p50", False), ("Ridge regression", "ridge", False),
                  ("Persistence", "persistence", False), ("Climatology", "climatology", False),
                  ("CAMS same-day analysis", "aqi_equiv", True)]
    out = {"note": "CAMS here is its analysis of the day itself, not a forecast made in advance: a reference point, "
                   "not a fair competitor. Live, the ledger grades CAMS's real 5-day forecasts against ours.",
           "horizons": []}
    for h, g in b.groupby("horizon_h"):
        rows = []
        for name, col, ref in contenders:
            gg = g.dropna(subset=[col])
            if not len(gg):
                continue
            e = gg.actual - gg[col]
            sev, warn = gg.actual > C.SEVERE, gg[col] > C.SEVERE
            hits, miss, fa = int((sev & warn).sum()), int((sev & ~warn).sum()), int((~sev & warn).sum())
            rows.append({"model": name, "reference": ref, "n": int(len(gg)),
                         "mae": round(float(e.abs().mean()), 1), "rmse": round(float(np.sqrt((e ** 2).mean())), 1),
                         "bias": round(float((gg[col] - gg.actual).mean()), 1),
                         "csi": round(hits / (hits + miss + fa), 3) if hits + miss + fa else None,
                         "severe_hits": hits, "severe_days": int(sev.sum())})
        # season wins (non-reference contenders only, lowest MAE)
        wins = {r["model"]: 0 for r in rows if not r["reference"]}
        for _, gs in g.groupby("season"):
            best = min(((n, (gs.actual - gs[c]).abs().mean()) for n, c, ref in contenders if not ref and gs[c].notna().any()),
                       key=lambda t: t[1])
            wins[best[0]] += 1
        for r in rows:
            r["season_wins"] = wins.get(r["model"])
        out["horizons"].append({"horizon_h": int(h), "seasons": int(g.season.nunique()),
                                "rows": sorted(rows, key=lambda r: (r["reference"], r["mae"]))})
    return out


# ───────────── drift monitor ─────────────
def _psi(ref: np.ndarray, cur: np.ndarray, bins: int = 10) -> float | None:
    """Population stability index with reference-quantile bins. Fewer bins for small windows,
    since PSI inflates when each bin holds only a handful of points."""
    ref, cur = ref[~np.isnan(ref)], cur[~np.isnan(cur)]
    if len(ref) < 50 or len(cur) < 10:
        return None
    bins = min(bins, max(4, len(cur) // 6))
    inner = np.unique(np.quantile(ref, np.linspace(0, 1, bins + 1))[1:-1])
    if not len(inner):
        return 0.0
    r = np.bincount(np.searchsorted(inner, ref, side="right"), minlength=len(inner) + 1) / len(ref)
    c = np.bincount(np.searchsorted(inner, cur, side="right"), minlength=len(inner) + 1) / len(cur)
    # Laplace smoothing: half a count per bin, so an empty tail bin in a 30-day window isn't infinite
    k = len(inner) + 1
    r = (r * len(ref) + 0.5) / (len(ref) + 0.5 * k)
    c = (c * len(cur) + 0.5) / (len(cur) + 0.5 * k)
    return round(float(np.sum((c - r) * np.log(c / r))), 4)


def drift(feats: pd.DataFrame, bt: pd.DataFrame, graded: pd.DataFrame | None, window: int = 30) -> dict:
    """Seasonally matched PSI with an empirical null.

    The last `window` issue days are compared with the same calendar days in earlier years.
    A 30-day window is always narrower than nine pooled years, so raw PSI thresholds (0.1/0.25)
    would cry wolf. Instead each earlier year's same window is scored against the pool of the
    other years; a feature only counts as drift when today's PSI beats the 90th percentile of
    that null (and the textbook 0.25 floor).
    """
    f = feats[feats.horizon_h == 24].copy()
    last = f.issue_date.max()
    cur = f[f.issue_date > last - pd.Timedelta(days=window)]
    d0, d1 = int(cur.issue_date.dt.dayofyear.min()), int(cur.issue_date.dt.dayofyear.max())
    fd = f.issue_date.dt.dayofyear
    in_win = (fd >= d0) & (fd <= d1) if d0 <= d1 else ((fd >= d0) | (fd <= d1))
    ref = f[in_win & (f.issue_date.dt.year < last.year)]
    years = sorted(ref.issue_date.dt.year.unique())
    lo, hi = d0, d1
    feats_out = []
    for c in FEATURES:
        if c in ("doy_sin", "doy_cos", "dow", "diwali_dist"):
            continue  # calendar features drift by construction
        p = _psi(ref[c].to_numpy(float), cur[c].to_numpy(float))
        if p is None:
            continue
        null = [x for y in years if (x := _psi(ref[ref.issue_date.dt.year != y][c].to_numpy(float),
                                               ref[ref.issue_date.dt.year == y][c].to_numpy(float))) is not None]
        p90 = float(np.quantile(null, 0.9)) if null else 0.25
        p50 = float(np.median(null)) if null else 0.1
        thr = max(0.25, p90)
        feats_out.append({"feature": c, "psi": p, "null_p50": round(p50, 3), "threshold": round(thr, 3),
                          "status": "drift" if p > thr else "watch" if p > max(0.1, p50) else "stable",
                          "ref_mean": _f(ref[c].mean()), "cur_mean": _f(cur[c].mean())})
    feats_out.sort(key=lambda r: -(r["psi"] / r["threshold"]))
    # error drift: backtest season-by-season MAE, and live graded MAE vs backtest expectation
    err = []
    if len(bt):
        for y, g in bt[bt.horizon_h == 48].groupby("season"):
            err.append({"season": int(y), "mae": round(float((g.actual - g.p50).abs().mean()), 1),
                        "mae_persistence": round(float((g.actual - g.persistence).abs().mean()), 1)})
    expected = float(np.mean([e["mae"] for e in err])) if err else None
    live = None
    if graded is not None and len(graded):
        gv = graded[(graded.source == "vayu") & (graded.horizon_h == 48)].tail(30)
        if len(gv):
            m = float(gv.abs_err.mean())
            live = {"n": int(len(gv)), "mae": round(m, 1), "expected": round(expected, 1) if expected else None,
                    "ratio": round(m / expected, 2) if expected else None,
                    "status": "drift" if expected and m > 1.3 * expected else "stable"}
    n_drift = sum(r["status"] == "drift" for r in feats_out)
    return {"window_days": window, "current": [str(cur.issue_date.min())[:10], str(last)[:10]],
            "reference": f"days {lo}–{hi} of the year, {int(ref.issue_date.dt.year.min()) if len(ref) else '–'}–{last.year - 1}",
            "reference_n": int(len(ref)), "current_n": int(len(cur)), "features": feats_out, "error_by_season": err,
            "live_error": live, "status": "drift" if n_drift or (live and live["status"] == "drift") else
            "watch" if any(r["status"] == "watch" for r in feats_out) else "stable"}


# ───────────── lineage ─────────────
LINEAGE = {
    "nodes": [
        ("src_firms", "NASA FIRMS", "source"), ("src_cpcb", "CPCB stations", "source"), ("src_openaq", "OpenAQ archive", "source"),
        ("src_meteo", "Open-Meteo", "source"), ("src_cams", "Copernicus CAMS", "source"),
        ("raw_fires", "raw_fires", "raw"), ("raw_aqi", "raw_aqi", "raw"), ("raw_weather", "raw_weather", "raw"), ("raw_cams", "raw_cams", "raw"),
        ("station_daily", "station_daily", "curated"), ("aqi_daily", "aqi_daily", "curated"), ("aqi_hourly_city", "aqi_hourly_city", "curated"),
        ("fires_daily", "fires_daily", "curated"), ("wind_daily", "wind_daily", "curated"), ("cams_daily", "cams_daily", "curated"),
        ("cams_forecast_daily", "cams_forecast_daily", "curated"),
        ("features", "features", "model"), ("backtest", "backtest", "model"), ("live_models", "live models", "model"), ("ledger", "ledger", "model"),
        ("findings", "Smog findings", "product"), ("desk", "GRAP desk", "product"), ("agent", "Ask Vayu", "product"),
        ("whatif", "What-if", "product"), ("arena", "Model arena", "product"), ("drift", "Drift monitor", "product"), ("api", "Public API", "product"),
    ],
    "edges": [
        ("src_firms", "raw_fires"), ("src_cpcb", "raw_aqi"), ("src_openaq", "raw_aqi"), ("src_meteo", "raw_weather"), ("src_cams", "raw_cams"),
        ("raw_aqi", "station_daily"), ("station_daily", "aqi_daily"), ("raw_aqi", "aqi_hourly_city"), ("raw_fires", "fires_daily"),
        ("raw_weather", "wind_daily"), ("raw_cams", "cams_daily"), ("raw_cams", "cams_forecast_daily"),
        ("aqi_daily", "features"), ("fires_daily", "features"), ("wind_daily", "features"),
        ("features", "backtest"), ("features", "live_models"), ("live_models", "ledger"), ("cams_forecast_daily", "ledger"),
        ("aqi_daily", "findings"), ("fires_daily", "findings"), ("wind_daily", "findings"), ("cams_daily", "findings"),
        ("backtest", "desk"), ("live_models", "desk"), ("aqi_daily", "agent"), ("backtest", "agent"),
        ("live_models", "whatif"), ("backtest", "arena"), ("cams_daily", "arena"), ("features", "drift"), ("backtest", "drift"),
        ("aqi_daily", "api"), ("fires_daily", "api"), ("wind_daily", "api"), ("ledger", "api"), ("station_daily", "api"),
    ],
}
STEP_FOR = {"raw_fires": "contracts · raw_fires", "raw_aqi": "contracts · raw_aqi", "raw_weather": "contracts · raw_weather",
            "raw_cams": "contracts · raw_cams", "features": "feature table (t0 → t0+h)", "backtest": "walk-forward backtest",
            "live_models": "live forecast (train on all history)", "ledger": "verify chain"}


def lineage(con, run) -> dict:
    steps = {s.step: s for s in run.steps}
    tables = set(con.execute("select table_name from information_schema.tables").df().table_name)
    nodes = []
    for nid, label, layer in LINEAGE["nodes"]:
        n = {"id": nid, "label": label, "layer": layer}
        if nid in tables:
            n["rows"] = int(con.execute(f"select count(*) from {nid}").fetchone()[0])
            n["columns"] = con.execute(f"select column_name, data_type from information_schema.columns where table_name='{nid}' "
                                       "order by ordinal_position").df().to_dict("records")
        st = steps.get(STEP_FOR.get(nid, nid))
        if st:
            n["status"], n["duration_s"] = st.status, st.duration_s
            n["checks"] = [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in st.checks]
            if st.freshness:
                n["freshness"] = str(st.freshness)[:16]
        nodes.append(n)
    return {"nodes": nodes, "edges": [{"from": a, "to": b} for a, b in LINEAGE["edges"]]}


# ───────────── public API + catalog ─────────────
API = C.ROOT / "site" / "api" / "v1"
DATASETS = [
    ("aqi/daily", "Delhi city AQI, daily", "select date, aqi, band, grap, pm25, pm10, n_stations from v_aqi_daily order by date",
     "CPCB method: mean of station AQIs (PM2.5 + PM10 sub-indices, ≥16 valid hours).", "CPCB via OpenCity / OpenAQ", "daily"),
    ("aqi/stations-latest", "Station AQI, latest full day",
     "select station, date, aqi, pm25, pm10, hours from v_station_daily where date = (select max(date) from v_station_daily) order by aqi desc",
     "One row per reporting station.", "CPCB via OpenCity / OpenAQ", "daily"),
    ("fires/daily", "Upwind fire detections, daily", "select * from v_fires_upwind order by date",
     "VIIRS detections in Punjab and Haryana, split by state.", "NASA FIRMS", "daily"),
    ("weather/daily", "Transport and mixing, daily", "select * from v_wind_daily order by date",
     "Delhi wind, northwest-wind share (Delhi and Ludhiana), mixing height, temperature, humidity, rain.", "Open-Meteo", "daily"),
    ("cams/daily", "Copernicus CAMS analysis, daily", "select * from v_cams_daily order by date",
     "CAMS PM2.5/PM10 converted with the same CPCB method.", "Copernicus CAMS via Open-Meteo", "daily"),
]


def write_api(con, overview: dict, backtest_metrics: dict) -> dict:
    API.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    catalog = []
    for path, title, sql, desc, source, cadence in DATASETS:
        df = con.execute(sql).df()
        for c in df.columns:
            if pd.api.types.is_datetime64_any_dtype(df[c]):
                df[c] = df[c].dt.strftime("%Y-%m-%d")
        f = API / f"{path}.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"generated_at": now, "rows": json.loads(df.to_json(orient="records"))}, separators=(",", ":")))
        schema = con.execute(f"describe ({sql})").df()[["column_name", "column_type"]].to_dict("records")
        fresh = str(df["date"].max()) if "date" in df and len(df) else None
        catalog.append({"id": path, "title": title, "endpoint": f"/api/v1/{path}.json", "description": desc, "source": source,
                        "cadence": cadence, "rows": int(len(df)), "freshness": fresh, "schema": schema,
                        "bytes": f.stat().st_size, "license": "Open data; attribute the original source"})
    e = ledger.load_entries()
    extra = {
        "forecast/latest": ("Latest forecast (72 hours)", {"generated_at": now, "forecast": overview.get("forecast"), "grap_call": overview.get("grap_call")}),
        "forecast/ledger": ("Every committed forecast", {"generated_at": now, "chain": ledger.verify(), "entries": json.loads(e.to_json(orient="records")) if len(e) else []}),
        "metrics/backtest": ("Backtest metrics", {"generated_at": now, **backtest_metrics}),
    }
    for path, (title, obj) in extra.items():
        f = API / f"{path}.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(obj, default=str, separators=(",", ":")))
        catalog.append({"id": path, "title": title, "endpoint": f"/api/v1/{path}.json", "description": title + ".",
                        "source": "Vayu Pramaan", "cadence": "daily", "rows": None, "freshness": now[:10], "schema": [],
                        "bytes": f.stat().st_size, "license": "Open data"})
    (API / "catalog.json").write_text(json.dumps({"generated_at": now, "datasets": catalog}, indent=1))
    (API / "openapi.json").write_text(json.dumps(_openapi(catalog), indent=1))
    return {"generated_at": now, "base": "/api/v1", "datasets": catalog}


def _openapi(catalog: list[dict]) -> dict:
    tmap = {"DATE": "string", "VARCHAR": "string", "DOUBLE": "number", "INTEGER": "integer", "BIGINT": "integer",
            "DECIMAL": "number", "FLOAT": "number", "HUGEINT": "integer", "BOOLEAN": "boolean"}
    paths = {}
    for d in catalog:
        props = {c["column_name"]: {"type": next((v for k, v in tmap.items() if str(c["column_type"]).upper().startswith(k)), "string")}
                 for c in d["schema"]}
        paths[d["endpoint"]] = {"get": {"summary": d["title"], "description": d["description"], "responses": {"200": {
            "description": "OK", "content": {"application/json": {"schema": {"type": "object", "properties": {
                "generated_at": {"type": "string", "format": "date-time"},
                **({"rows": {"type": "array", "items": {"type": "object", "properties": props}}} if props else {})}}}}}}}}
    return {"openapi": "3.1.0", "info": {"title": "Vayu Pramaan open data API", "version": "1.0.0",
            "description": "Static JSON endpoints rebuilt daily at 06:00 IST. No key, no rate limit."}, "paths": paths}
