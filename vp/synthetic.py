"""Synthetic raw data with realistic structure, for testing the whole pipeline offline.

NOT real observations. Every artefact built from it is flagged SYNTHETIC in the manifest
and the site shows a banner. Physics baked in: winter inversion (low boundary layer),
Oct–Nov stubble fires in Punjab/Haryana, ~1-day smoke transport on northwest wind, Diwali spike.
"""
from __future__ import annotations

import shutil
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import config as C

STATIONS = ["Anand Vihar", "ITO", "RK Puram", "Punjabi Bagh", "Dwarka Sector 8", "Rohini",
            "Okhla Phase 2", "Jahangirpuri", "Lodhi Road", "Pusa", "Wazirpur", "Narela"]


def generate(today: date, seed: int = 7) -> int:
    assert C.SYNTHETIC, "synthetic data may only be written inside the data/synthetic sandbox"
    rng = np.random.default_rng(seed)
    for sub in ("fires", "aqi", "weather", "cams"):
        shutil.rmtree(C.RAW / sub, ignore_errors=True)
        (C.RAW / sub).mkdir(parents=True, exist_ok=True)

    days = pd.date_range(C.HISTORY_START, today - timedelta(days=1), freq="D")
    n = len(days)
    doy = days.dayofyear.to_numpy()
    yrs = days.year.to_numpy()

    # ---- fires: kharif (Oct–Nov) + rabi (Apr–May), declining trend in Punjab ----
    kharif = np.exp(-((doy - 308) / 13.0) ** 2)
    rabi = 0.25 * np.exp(-((doy - 120) / 12.0) ** 2)
    trend = np.interp(yrs, [2017, 2025], [1.0, 0.45])
    lam = 2600 * kharif * trend * rng.lognormal(0, 0.35, n) + 700 * rabi + 2
    fires_n = rng.poisson(lam)
    pb_share = np.clip(np.interp(yrs, [2017, 2025], [0.82, 0.6]) + rng.normal(0, 0.04, n), 0.3, 0.95)
    fires_pb = rng.binomial(fires_n, pb_share)

    # ---- weather: NW regime persistence, higher in post-monsoon; winter inversion ----
    nw = np.zeros(n)
    p_nw = 0.35 + 0.35 * np.exp(-((doy - 305) / 30.0) ** 2)
    state = 0.0
    for i in range(n):
        state = 0.6 * state + 0.4 * (rng.random() < p_nw[i])
        nw[i] = np.clip(state + rng.normal(0, 0.12), 0, 1)
    winter = np.cos(2 * np.pi * (doy - 15) / 365.25)  # +1 mid-Jan, -1 mid-July
    blh = np.clip(900 - 450 * winter + rng.normal(0, 120, n), 150, 2200)
    wind_speed = np.clip(2.4 - 0.8 * winter + rng.normal(0, 0.6, n), 0.3, 8)
    monsoon = np.exp(-((doy - 205) / 30.0) ** 2)
    precip = rng.gamma(0.6, 6.0, n) * (rng.random(n) < 0.08 + 0.55 * monsoon)

    # ---- PM2.5 daily: local base + transported smoke + inversion + festival ----
    fires_lag1 = np.roll(fires_n, 1); fires_lag1[0] = 0
    diwali = pd.to_datetime(list(C.DIWALI.values()))
    dw = np.zeros(n)
    for d in diwali:
        k = np.abs((days - d).days.to_numpy())
        dw += np.where(k <= 1, 70 - 20 * k, 0)
    weekend = np.isin(days.dayofweek, [5, 6]).astype(float)
    base = 55 + 55 * np.clip(winter, -0.4, 1)
    trans = 0.075 * fires_lag1 * (0.35 + 1.1 * nw)
    inversion = 38000 / blh
    pm25 = base + trans + inversion - 12 * wind_speed - 1.8 * precip + dw - 7 * weekend
    ar = np.zeros(n)
    for i in range(1, n):
        ar[i] = 0.55 * ar[i - 1] + rng.normal(0, 13)
    pm25 = np.clip(pm25 + ar, 12, 900)
    pm10 = pm25 * rng.uniform(1.6, 2.1, n)

    # ---- hourly station data ----
    hours = np.arange(24)
    diurnal = 1 + 0.28 * np.cos(2 * np.pi * (hours - 22) / 24)
    frames = []
    for j, st in enumerate(STATIONS):
        bias = rng.normal(1.0, 0.12)
        cover = rng.random(n) > 0.04  # 4% missing station-days
        start = 0 if j < 9 else np.searchsorted(days, pd.Timestamp("2019-06-01"))  # later stations
        idx = np.arange(start, n)[cover[start:]]
        ts = (days[idx].to_numpy()[:, None] + (hours * 3600 * 10**9).astype("timedelta64[ns]")).ravel()
        v25 = (pm25[idx, None] * bias * diurnal * rng.lognormal(0, 0.12, (len(idx), 24))).ravel()
        v10 = (pm10[idx, None] * bias * diurnal * rng.lognormal(0, 0.12, (len(idx), 24))).ravel()
        drop = rng.random(v25.size) < 0.05
        v25[drop] = np.nan
        frames.append(pd.DataFrame({"station": st, "ts": ts, "pm25": v25.round(1), "pm10": v10.round(1)}))
    aqi = pd.concat(frames, ignore_index=True)
    aqi.to_parquet(C.RAW / "aqi" / "synthetic.parquet", index=False)

    # ---- fire points ----
    rows = np.repeat(np.arange(n), fires_n)
    is_pb = np.concatenate([np.r_[np.ones(p, bool), np.zeros(t - p, bool)] for p, t in zip(fires_pb, fires_n)]) \
        if len(rows) else np.array([], bool)
    lat = np.where(is_pb, rng.uniform(29.7, 31.9, len(rows)), rng.uniform(28.6, 30.4, len(rows)))
    lon = np.where(is_pb, rng.uniform(74.4, 76.6, len(rows)), rng.uniform(75.4, 77.3, len(rows)))
    fires = pd.DataFrame({"date": days[rows].date, "time_utc": rng.choice(["0745", "0830", "2010", "2055"], len(rows)),
                          "lat": lat.round(4), "lon": lon.round(4), "frp": rng.gamma(1.4, 5.0, len(rows)).round(1),
                          "confidence": "n", "satellite": "SYNTH", "state": np.where(is_pb, "Punjab", "Haryana")})
    fires.to_parquet(C.RAW / "fires" / "synthetic.parquet", index=False)

    # ---- hourly weather, 2 sites ----
    wf = []
    for site, off in (("delhi", 0), ("ludhiana", 1)):
        ts = (days.to_numpy()[:, None] + (hours * 3600 * 10**9).astype("timedelta64[ns]")).ravel()
        nw_d = np.roll(nw, -off) if off else nw
        is_nw = rng.random((n, 24)) < nw_d[:, None]
        wdir = np.where(is_nw, rng.uniform(280, 335, (n, 24)), rng.uniform(40, 250, (n, 24)))
        wf.append(pd.DataFrame({
            "site": site, "ts": ts, "wind_speed": np.clip(wind_speed[:, None] + rng.normal(0, .5, (n, 24)), 0, 12).ravel().round(2),
            "wind_dir": wdir.ravel().round(0),
            "temp": (26 - 11 * winter[:, None] + 5 * np.sin(2 * np.pi * (hours - 9) / 24) + rng.normal(0, 1, (n, 24))).ravel().round(1),
            "rh": np.clip(55 + 20 * monsoon[:, None] + rng.normal(0, 8, (n, 24)), 8, 100).ravel().round(0),
            "precip": (np.repeat(precip / 24, 24)).round(2),
            "blh": np.clip(blh[:, None] * (0.35 + 1.1 * np.clip(np.sin(np.pi * (hours - 6) / 12), 0, 1)), 60, 3000).ravel().round(0)}))
    pd.concat(wf).to_parquet(C.RAW / "weather" / "hist_synthetic.parquet", index=False)

    # ---- CAMS: biased low on smoky days, from Aug 2022 ----
    m = days >= pd.Timestamp("2022-08-01")
    cd = days[m]
    c25 = pm25[m] * 0.72 - 0.02 * fires_lag1[m] + rng.normal(0, 18, m.sum())
    ts = (cd.to_numpy()[:, None] + (hours * 3600 * 10**9).astype("timedelta64[ns]")).ravel()
    cams = pd.DataFrame({"kind": "analysis", "issued": pd.NaT, "ts": ts,
                         "pm25": np.clip(np.repeat(c25, 24) * np.tile(diurnal, len(cd)), 5, None).round(1),
                         "pm10": np.clip(np.repeat(c25 * 1.7, 24), 8, None).round(1)})
    cams.to_parquet(C.RAW / "cams" / "analysis.parquet", index=False)
    last = pm25[-1] * 0.72
    fts = pd.date_range(pd.Timestamp(today), periods=5 * 24, freq="h")
    pd.DataFrame({"kind": "forecast", "issued": pd.Timestamp(today), "ts": fts,
                  "pm25": (last + rng.normal(0, 10, len(fts))).clip(5).round(1),
                  "pm10": (last * 1.7 + rng.normal(0, 15, len(fts))).clip(8).round(1)}) \
        .to_parquet(C.RAW / "cams" / f"forecast_{today:%Y%m%d}.parquet", index=False)

    return len(aqi) + len(fires) + sum(len(x) for x in wf) + len(cams)
