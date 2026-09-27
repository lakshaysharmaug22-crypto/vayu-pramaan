"""Central config for Vayu Pramaan. Every path, region and threshold lives here."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Synthetic runs (offline testing) get their own raw data, database and ledger, so they can
# never overwrite real downloads or mix fake forecasts into the public ledger.
SYNTHETIC = os.getenv("VP_SYNTHETIC") == "1"
DATA = ROOT / "data" / "synthetic" if SYNTHETIC else ROOT / "data"
RAW = DATA / "raw"
DB_PATH = DATA / "vayu.duckdb"
SITE_DATA = ROOT / "site" / "data"
LEDGER_DIR = DATA / "ledger" if SYNTHETIC else ROOT / "ledger"

# Delhi centre (used for weather + CAMS point queries)
DELHI_LAT, DELHI_LON = 28.6139, 77.2090

# Upwind fire region: Punjab + Haryana (bbox, refined by state polygons when available)
FIRE_BBOX = {"south": 27.6, "north": 32.6, "west": 73.8, "east": 77.6}  # lat/lon
# Rough state split used only when no boundary file is present (documented as approximate)
PUNJAB_BBOX = {"south": 29.5, "north": 32.6, "west": 73.8, "east": 76.9}

# Northwest wind corridor (degrees, wind FROM this direction)
NW_DIR_MIN, NW_DIR_MAX = 270, 340

# Seasons
HISTORY_START = "2017-01-01"
SEASON_MONTHS = (10, 11)          # Oct-Nov burning season
BACKTEST_SEASONS = list(range(2019, 2026))
HORIZONS_H = (24, 48, 72)

# CPCB AQI categories and GRAP stages (CAQM)
AQI_BANDS = [(0, 50, "Good"), (51, 100, "Satisfactory"), (101, 200, "Moderate"),
             (201, 300, "Poor"), (301, 400, "Very poor"), (401, 500, "Severe")]
GRAP_STAGES = [(201, 300, "Stage I"), (301, 400, "Stage II"),
               (401, 450, "Stage III"), (451, 10_000, "Stage IV")]
SEVERE = 400

# Festival calendar (Diwali dates) for the festival feature + finding
DIWALI = {2017: "2017-10-19", 2018: "2018-11-07", 2019: "2019-10-27", 2020: "2020-11-14",
          2021: "2021-11-04", 2022: "2022-10-24", 2023: "2023-11-12", 2024: "2024-10-31",
          2025: "2025-10-20", 2026: "2026-11-08"}

# Stations used for the city average (CPCB method: mean of station AQIs)
MIN_STATIONS_PER_DAY = 5

for p in (RAW, SITE_DATA, LEDGER_DIR):
    p.mkdir(parents=True, exist_ok=True)
