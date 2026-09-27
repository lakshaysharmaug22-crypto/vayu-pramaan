"""Stage 4 · Features. One row per (issue day t0, horizon h): only what is known at t0."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C

FEATURES = [
    "aqi_0", "aqi_1", "aqi_ma3", "aqi_ma7", "pm25_0",
    "fires_0", "fires_1", "fires_2", "fires_sum3", "fires_trend", "punjab_share_0", "frp_0",
    "nw_frac_0", "nw_frac_upwind_0", "wind_speed_0", "blh_0", "blh_min_0", "temp_0", "rh_0", "precip_0",
    "doy_sin", "doy_cos", "dow", "diwali_dist",
]


def daily_frame(con) -> pd.DataFrame:
    df = con.execute("""
        select a.date, a.aqi, a.pm25,
               coalesce(f.fires, 0) fires, coalesce(f.fires_punjab, 0) fires_punjab, coalesce(f.frp_sum, 0) frp,
               w.nw_frac, w.nw_frac_upwind, w.wind_speed, w.blh, w.blh_min, w.temp, w.rh, w.precip
        from aqi_daily a
        left join fires_daily f using (date)
        left join wind_daily w using (date)
        order by a.date""").df()
    df["date"] = pd.to_datetime(df["date"])
    # Reindex to a continuous calendar so shifts mean "days", not "rows"
    df = df.set_index("date").asfreq("D").reset_index()
    return df


def _diwali_dist(d: pd.Series) -> np.ndarray:
    dw = {y: pd.Timestamp(v) for y, v in C.DIWALI.items()}
    out = []
    for t in d:
        if pd.isna(t):
            out.append(np.nan); continue
        cand = [abs((t - dw[y]).days) for y in (t.year - 1, t.year, t.year + 1) if y in dw]
        out.append(min(min(cand), 30) if cand else 30)
    return np.array(out, dtype=float)


def build(daily: pd.DataFrame, horizons_days=(1, 2, 3)) -> pd.DataFrame:
    d = daily.copy()
    base = pd.DataFrame({"issue_date": d["date"]})
    base["aqi_0"] = d["aqi"]
    base["aqi_1"] = d["aqi"].shift(1)
    base["aqi_ma3"] = d["aqi"].rolling(3, min_periods=2).mean()
    base["aqi_ma7"] = d["aqi"].rolling(7, min_periods=4).mean()
    base["pm25_0"] = d["pm25"]
    base["fires_0"] = d["fires"]
    base["fires_1"] = d["fires"].shift(1)
    base["fires_2"] = d["fires"].shift(2)
    base["fires_sum3"] = d["fires"].rolling(3, min_periods=1).sum()
    base["fires_trend"] = d["fires"] - d["fires"].shift(2)
    base["punjab_share_0"] = (d["fires_punjab"] / d["fires"].replace(0, np.nan)).fillna(0)
    base["frp_0"] = d["frp"]
    for c in ["nw_frac", "nw_frac_upwind", "wind_speed", "blh", "blh_min", "temp", "rh", "precip"]:
        base[f"{c}_0"] = d[c]

    rows = []
    for h in horizons_days:
        r = base.copy()
        r["horizon_h"] = h * 24
        r["target_date"] = r["issue_date"] + pd.Timedelta(days=h)
        r["target"] = d["aqi"].shift(-h)
        doy = r["target_date"].dt.dayofyear
        r["doy_sin"], r["doy_cos"] = np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25)
        r["dow"] = r["target_date"].dt.dayofweek
        r["diwali_dist"] = _diwali_dist(r["target_date"])
        rows.append(r)
    out = pd.concat(rows, ignore_index=True)
    return out[out["aqi_0"].notna()].reset_index(drop=True)
