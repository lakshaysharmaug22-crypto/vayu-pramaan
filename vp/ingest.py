"""Stage 1 · Ingest. Four sources, all key-free, each normalised to one parquet schema.

  fires     NASA FIRMS VIIRS detections over Punjab + Haryana
  aqi       CPCB station PM2.5/PM10 (OpenCity CSV exports, OpenAQ open archive for recent days)
  weather   Open-Meteo hourly weather at Delhi and upwind (Ludhiana)
  cams      Open-Meteo air-quality (Copernicus CAMS) analysis + 5-day forecast snapshots

Normalised schemas (parquet under data/raw/<source>/):
  fires:    date, time_utc, lat, lon, frp, confidence, satellite, state
  aqi:      station, ts, pm25, pm10                   (ts = hourly, IST, naive)
  weather:  site, ts, wind_speed, wind_dir, temp, rh, precip, blh
  cams:     kind ('analysis'|'forecast'), issued, ts, pm25, pm10
"""
from __future__ import annotations

import gzip
import io
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import config as C
from .geo import assign_state
from .runner import Check

UA = {"User-Agent": "vayu-pramaan/1.0 (open air-quality research project)"}
SESSION = requests.Session()
SESSION.headers.update(UA)


def _get(url: str, params: dict | None = None, tries: int = 3, timeout: int = 60) -> requests.Response:
    last = None
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code} for {r.url}: {r.text[:200]}")
            if r.status_code in (400, 401, 403, 404):
                break  # not worth retrying
        except requests.RequestException as e:
            last = e
        time.sleep(2 ** i)
    raise last  # type: ignore[misc]


def _out(source: str) -> Path:
    p = C.RAW / source
    p.mkdir(parents=True, exist_ok=True)
    return p


def _save(df: pd.DataFrame, source: str, name: str) -> Path:
    path = _out(source) / f"{name}.parquet"
    df.to_parquet(path, index=False)
    return path


# ─────────────────────────── fires ───────────────────────────
FIRMS_LIVE = [
    ("NOAA-20", "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_7d.csv"),
    ("S-NPP", "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_7d.csv"),
]
# Yearly per-country archive files. Tried in order; first that works wins.
FIRMS_YEARLY = [
    "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/{y}/viirs-snpp_{y}_India.csv",
    "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-noaa20/{y}/viirs-noaa20_{y}_India.csv",
]
FIRMS_AREA_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{src}/{bbox}/{days}/{d}"


def _normalise_fires(df: pd.DataFrame, satellite: str) -> pd.DataFrame:
    df = df.rename(columns=str.lower)
    b = C.FIRE_BBOX
    df = df[(df.latitude.between(b["south"], b["north"])) & (df.longitude.between(b["west"], b["east"]))].copy()
    out = pd.DataFrame({
        "date": pd.to_datetime(df["acq_date"]).dt.date,
        "time_utc": df["acq_time"].astype(str).str.zfill(4),
        "lat": df["latitude"].astype(float),
        "lon": df["longitude"].astype(float),
        "frp": pd.to_numeric(df.get("frp"), errors="coerce"),
        "confidence": df.get("confidence").astype(str) if "confidence" in df else "n",
        "satellite": satellite,
    })
    out["state"] = assign_state(out["lat"].to_numpy(), out["lon"].to_numpy())
    return out[out.state.isin(["Punjab", "Haryana"])]


def fires_live(res) -> pd.DataFrame:
    frames = []
    for sat, url in FIRMS_LIVE:
        try:
            frames.append(_normalise_fires(pd.read_csv(io.StringIO(_get(url).text)), sat))
        except Exception as e:  # one satellite failing should not kill the run
            res.notes += f"{sat} live feed failed: {e}. "
    if not frames:
        raise RuntimeError("both FIRMS live feeds failed")
    df = pd.concat(frames, ignore_index=True)
    _save(df, "fires", f"live_{date.today():%Y%m%d}")
    return df


def fires_history(res, years: list[int]) -> pd.DataFrame:
    """Yearly archive → FIRMS area API (needs FIRMS_MAP_KEY) → files you drop in data/raw/fires_manual/."""
    frames = []
    for y in years:
        target = _out("fires") / f"hist_{y}.parquet"
        if target.exists():
            frames.append(pd.read_parquet(target)); continue
        got = None
        for tmpl in FIRMS_YEARLY:
            try:
                txt = _get(tmpl.format(y=y), timeout=300).text
                got = _normalise_fires(pd.read_csv(io.StringIO(txt)), "S-NPP" if "snpp" in tmpl else "NOAA-20")
                break
            except Exception as e:
                res.notes += f"{y}: yearly archive unavailable ({str(e)[:80]}). "
        if got is None and os.getenv("FIRMS_MAP_KEY"):
            got = _fires_area_api(y, os.environ["FIRMS_MAP_KEY"])
        if got is None:
            got = _fires_manual(y)
        if got is not None and len(got):
            got.to_parquet(target, index=False)
            frames.append(got)
        else:
            res.notes += f"{y}: no fire data (see README › Fire data fallback). "
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def _fires_area_api(y: int, key: str) -> pd.DataFrame | None:
    b = C.FIRE_BBOX
    bbox = f"{b['west']},{b['south']},{b['east']},{b['north']}"
    frames, d = [], date(y, 9, 1)
    while d <= date(y, 12, 31):
        url = FIRMS_AREA_API.format(key=key, src="VIIRS_SNPP_SP", bbox=bbox, days=10, d=d.isoformat())
        try:
            frames.append(pd.read_csv(io.StringIO(_get(url).text)))
        except Exception:
            pass
        d += timedelta(days=10)
    frames = [f for f in frames if len(f)]
    return _normalise_fires(pd.concat(frames), "S-NPP") if frames else None


def _fires_manual(y: int) -> pd.DataFrame | None:
    files = list((C.RAW / "fires_manual").glob(f"*{y}*.csv"))
    if not files:
        return None
    return _normalise_fires(pd.concat(pd.read_csv(f) for f in files), "manual")


# ─────────────────────────── station AQI ───────────────────────────
OPENAQ_ARCHIVE = "https://openaq-data-archive.s3.amazonaws.com/records/csv.gz/locationid={lid}/year={y}/month={m:02d}/location-{lid}-{y}{m:02d}{d:02d}.csv.gz"
# OpenAQ location ids for Delhi CPCB/DPCC stations. Find more on explore.openaq.org (search "Delhi").
OPENAQ_DELHI = {235: "Anand Vihar"}


def _pick(cols: list[str], *patterns: str) -> str | None:
    for p in patterns:
        for c in cols:
            if re.search(p, c, re.I):
                return c
    return None


AGENCY = re.compile(r"\b(dpcc|cpcb|imd|iitm|du)\b", re.I)
SERIES = re.compile(r"(15 minute )?aqi data( for)? ?\d{4}(-\d{2,4})?", re.I)
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}


def station_key(name: str) -> str:
    n = re.sub(r"[-_,()]+", " ", str(name).lower())
    n = re.sub(r"\b(15 minute|aqi|data|for|dilshad garden|delhi|new)\b|\b\d{2,4}\b", " ", n)
    n = AGENCY.sub(" ", n)
    return re.sub(r"[^a-z0-9]", "", n)


def station_label(name: str) -> str:
    n = SERIES.sub("", str(name))
    n = re.sub(r"[-_]+", " ", AGENCY.sub("", n))
    n = re.sub(r"\b(aqi|data|for|15|minute|csv|\d{4}( \d{2,4})?)\b", "", n, flags=re.I)
    return re.sub(r"\s+", " ", n).strip().title().replace("R K ", "RK ").replace("Crri", "CRRI").replace("Dtu", "DTU") \
        .replace("Igi", "IGI").replace("Ihbas", "IHBAS").replace("Nsit", "NSIT").replace("Ito", "ITO")


def _parse_cpcb_grid(text: str, station: str) -> pd.DataFrame:
    """CPCB monthly report grid: 'Year,2017', 'January-2017,00:00:00,…', then 'day,v0,…,v23' rows of hourly AQI."""
    rows, year, month = [], None, None
    for line in text.splitlines():
        line = line.strip().strip('"')
        if not line:
            continue
        head = line.split(",", 1)[0].strip()
        if head.lower() == "year":
            continue
        m = re.match(r"^([A-Za-z]+)-(\d{4})$", head)
        if m and m.group(1).lower() in MONTHS:
            month, year = MONTHS[m.group(1).lower()], int(m.group(2)); continue
        if month and head.isdigit():
            day = int(head)
            vals = line.split(",")[1:25]
            for h, v in enumerate(vals):
                v = v.strip()
                if v:
                    try:
                        rows.append((year, month, day, h, float(v)))
                    except ValueError:
                        pass
    if not rows:
        return pd.DataFrame(columns=["station", "ts", "pm25", "pm10", "aqi"])
    df = pd.DataFrame(rows, columns=["y", "m", "d", "h", "aqi"])
    df["ts"] = pd.to_datetime(dict(year=df.y, month=df.m, day=df.d, hour=df.h), errors="coerce")
    df = df.dropna(subset=["ts"])
    return pd.DataFrame({"station": station, "ts": df.ts, "pm25": np.nan, "pm10": np.nan, "aqi": df.aqi})


def _parse_long(df: pd.DataFrame, station: str, res) -> pd.DataFrame | None:
    cols = list(df.columns)
    tcol = _pick(cols, r"^timestamp", r"^(from|datetime|date ?time)", r"date", r"time")
    p25, p10 = _pick(cols, r"pm\s*2\.?5", r"pm25"), _pick(cols, r"pm\s*10\b", r"^pm10")
    if not tcol or not p25:
        res.notes += f"skipped {station}: no time/PM2.5 columns. "
        return None
    ts = pd.to_datetime(df[tcol], errors="coerce", utc=True)
    if ts.notna().mean() < .5:
        ts = pd.to_datetime(df[tcol], errors="coerce", dayfirst=True).dt.tz_localize("Asia/Kolkata")
    out = pd.DataFrame({"station": station, "ts": ts.dt.tz_convert("Asia/Kolkata").dt.tz_localize(None),
                        "pm25": pd.to_numeric(df[p25], errors="coerce"),
                        "pm10": pd.to_numeric(df[p10], errors="coerce") if p10 else np.nan, "aqi": np.nan})
    out = out.dropna(subset=["ts"])
    out["ts"] = out["ts"].dt.floor("h")
    return out.groupby(["station", "ts"], as_index=False)[["pm25", "pm10", "aqi"]].mean()


def aqi_opencity(res) -> pd.DataFrame:
    """Parse the OpenCity CPCB station files in data/raw/aqi_opencity/.

    2017–2023 files are CPCB's hourly station AQI in a monthly grid; 2024–25 files are 15-minute
    concentrations (PM2.5, PM10) in long form. Both are normalised to station/ts rows.
    """
    folder = C.RAW / "aqi_opencity"
    files = sorted(folder.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"no CSVs in {folder}. Run scripts/fetch_opencity.py first.")
    frames, labels = [], {}
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        key = station_key(f.stem.replace("-", " "))
        labels.setdefault(key, station_label(f.stem))
        if text.lstrip().lower().startswith("year,"):
            frames.append(_parse_cpcb_grid(text, labels[key]))
        else:
            d = _parse_long(pd.read_csv(io.StringIO(text), low_memory=False), labels[key], res)
            if d is not None:
                frames.append(d)
    df = pd.concat([x for x in frames if len(x)], ignore_index=True)
    df = df.groupby(["station", "ts"], as_index=False)[["pm25", "pm10", "aqi"]].mean()
    _save(df, "aqi", "opencity")
    res.rows_in = len(files)
    res.notes += f"{df.station.nunique()} stations, {df.ts.min():%Y-%m-%d} to {df.ts.max():%Y-%m-%d}. "
    return df


def aqi_openaq_recent(res, days: int = 10) -> pd.DataFrame:
    """Recent days from the OpenAQ open archive (no key). Used for live grading."""
    return aqi_openaq(res, date.today() - timedelta(days=days), date.today() - timedelta(days=1),
                      f"openaq_recent_{date.today():%Y%m%d}")


def aqi_openaq(res, start: date, end: date, name: str) -> pd.DataFrame:
    """Daily files from the OpenAQ open archive (no key) for every Delhi location, start..end inclusive.
    History mode uses it to fill the gap between the last CPCB station export and today."""
    n = (end - start).days + 1
    jobs = [(lid, start + timedelta(days=k)) for lid in OPENAQ_DELHI for k in range(max(n, 0))]

    def one(job):
        lid, d = job
        url = OPENAQ_ARCHIVE.format(lid=lid, y=d.year, m=d.month, d=d.day)
        try:
            raw = gzip.decompress(_get(url, tries=2).content)
            return pd.read_csv(io.BytesIO(raw)).assign(location_id=lid)
        except Exception:
            return None

    with ThreadPoolExecutor(8) as ex:
        frames = [f for f in ex.map(one, jobs) if f is not None]
    if not frames:
        raise RuntimeError(f"no OpenAQ archive files found for {start}..{end} (archive may lag 1-2 days)")
    res.checks.append(Check("OpenAQ daily files found", True, f"{len(frames)}/{len(jobs)}", "warn"))
    raw = pd.concat(frames, ignore_index=True)
    raw = raw[raw["parameter"].isin(["pm25", "pm10"])]
    raw["ts"] = pd.to_datetime(raw["datetime"], utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None).dt.floor("h")
    raw["station"] = raw["location_id"].map(OPENAQ_DELHI)
    df = raw.pivot_table(index=["station", "ts"], columns="parameter", values="value", aggfunc="mean").reset_index()
    df = df.rename(columns={"pm25": "pm25", "pm10": "pm10"})
    for c in ("pm25", "pm10"):
        if c not in df:
            df[c] = pd.NA
    df["aqi"] = np.nan
    df = df[["station", "ts", "pm25", "pm10", "aqi"]]
    _save(df, "aqi", name)
    return df


# ─────────────────────────── weather ───────────────────────────
WEATHER_SITES = {"delhi": (C.DELHI_LAT, C.DELHI_LON), "ludhiana": (30.901, 75.857)}
W_VARS = ["wind_speed_10m", "wind_direction_10m", "temperature_2m", "relative_humidity_2m",
          "precipitation", "boundary_layer_height"]
W_RENAME = {"wind_speed_10m": "wind_speed", "wind_direction_10m": "wind_dir", "temperature_2m": "temp",
            "relative_humidity_2m": "rh", "precipitation": "precip", "boundary_layer_height": "blh"}


def _om_hourly(url: str, lat: float, lon: float, variables: list[str], **extra) -> pd.DataFrame:
    params = {"latitude": lat, "longitude": lon, "hourly": ",".join(variables), "timezone": "Asia/Kolkata", **extra}
    try:
        js = _get(url, params).json()
    except RuntimeError as e:
        if "boundary_layer_height" in variables and "400" in str(e):
            return _om_hourly(url, lat, lon, [v for v in variables if v != "boundary_layer_height"], **extra)
        raise
    h = js["hourly"]
    df = pd.DataFrame(h).rename(columns={"time": "ts"})
    df["ts"] = pd.to_datetime(df["ts"])
    return df


def _tidy_weather(df: pd.DataFrame, site: str) -> pd.DataFrame:
    df = df.rename(columns=W_RENAME)
    for c in W_RENAME.values():
        if c not in df:
            df[c] = pd.NA
    df["site"] = site
    return df[["site", "ts", *W_RENAME.values()]]


def weather_history(res, start: str, end: str) -> pd.DataFrame:
    frames = []
    for site, (lat, lon) in WEATHER_SITES.items():
        y0, y1 = int(start[:4]), int(end[:4])
        for y in range(y0, y1 + 1):
            target = _out("weather") / f"hist_{site}_{y}.parquet"
            if target.exists() and y < date.today().year:
                frames.append(pd.read_parquet(target)); continue
            s, e = max(start, f"{y}-01-01"), min(end, f"{y}-12-31")
            df = _tidy_weather(_om_hourly("https://archive-api.open-meteo.com/v1/archive", lat, lon, W_VARS,
                                          start_date=s, end_date=e), site)
            df.to_parquet(target, index=False)
            frames.append(df)
    return pd.concat(frames, ignore_index=True)


def weather_forecast(res) -> pd.DataFrame:
    frames = [_tidy_weather(_om_hourly("https://api.open-meteo.com/v1/forecast", lat, lon, W_VARS,
                                       past_days=3, forecast_days=4), site)
              for site, (lat, lon) in WEATHER_SITES.items()]
    df = pd.concat(frames, ignore_index=True)
    _save(df, "weather", f"forecast_{date.today():%Y%m%d}")
    return df


# ─────────────────────────── CAMS ───────────────────────────
CAMS_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
CAMS_START = "2022-08-01"  # CAMS global availability through Open-Meteo


def cams_history(res, end: str) -> pd.DataFrame:
    target = _out("cams") / "analysis.parquet"
    df = _om_hourly(CAMS_URL, C.DELHI_LAT, C.DELHI_LON, ["pm2_5", "pm10"],
                    start_date=CAMS_START, end_date=end, domains="cams_global")
    df = df.rename(columns={"pm2_5": "pm25"})
    df = df.assign(kind="analysis", issued=pd.NaT)[["kind", "issued", "ts", "pm25", "pm10"]]
    df.to_parquet(target, index=False)
    return df


def cams_forecast(res) -> pd.DataFrame:
    """Today's CAMS 5-day forecast. Snapshotted daily so it can be graded like ours."""
    df = _om_hourly(CAMS_URL, C.DELHI_LAT, C.DELHI_LON, ["pm2_5", "pm10"], forecast_days=5, domains="cams_global")
    df = df.rename(columns={"pm2_5": "pm25"})
    df = df.assign(kind="forecast", issued=pd.Timestamp(date.today()))[["kind", "issued", "ts", "pm25", "pm10"]]
    _save(df, "cams", f"forecast_{date.today():%Y%m%d}")
    return df


def latest_ts(df: pd.DataFrame, col: str) -> str | None:
    if df is None or not len(df) or col not in df:
        return None
    return str(pd.to_datetime(df[col]).max())
