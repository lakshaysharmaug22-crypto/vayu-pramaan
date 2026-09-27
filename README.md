# Vayu Pramaan · वायु प्रमाण

**Delhi air-quality forecasts you don't have to trust.** Every forecast is hashed and committed to a public ledger *before* the day happens, then graded in the open against what CPCB stations recorded and against Copernicus CAMS.

Release-gated by [Nomad Loop Engine](https://github.com/lakshaysharmaug22-crypto/nomad-loop-engine), an autonomous QA agent that explores this site like a user on every deploy.

## What's inside

| Section | Role it shows | What it does |
|---|---|---|
| Next 72 hours | Data Science | Quantile LightGBM (p10/p50/p90) per horizon, split-conformal calibration, walk-forward backtest vs persistence + climatology, Diebold-Mariano test, SHAP drivers |
| Smog findings | Data Analyst | Six SQL findings (smoke lag, wind corridor, local floor, state split, Diwali/weekend, CAMS misses) + KPI dictionary |
| GRAP decision desk | Business Analyst | Forecast → GRAP stage call; cost sliders set the warning threshold; season cost vs reacting on the day; stakeholder memo |
| Ask Vayu | AI Analytics | Text-to-SQL agent on read-only whitelisted views with guardrails, 25-question eval, daily AI brief |
| Live · Pipeline | Data Engineering | 8-stage pipeline, data contracts, freshness checks, run manifests, halt-on-failure |
| What-if simulator | Data Science · Business | Live models re-forecast under changed fires, wind and mixing height (model response, not causal) |
| Model arena | Data Science | LightGBM vs ridge, persistence, climatology; CAMS as a labelled reference |
| Lineage | Data Engineering | Interactive DAG from sources to screens with live row counts and check status |
| Model health | MLOps | Seasonal PSI with an empirical null per input, error drift by season, live error vs backtest |
| Open data | Data Engineering | Static JSON API v1, OpenAPI 3.1 spec, dataset catalog with schemas and freshness |
| Search | Product | Command palette (/ or Ctrl+K): dates, stations, findings, questions, blocks, endpoints |
| Public ledger | Systems | SHA-256 + Merkle root + hash chain, append-only, verifiable in the browser, OpenTimestamps anchoring |
| Tested by Nomad Loop | Engineering QA | Nomad Loop Engine scans the live site after every deploy (its GitHub Action); report shared with Nomad's /target page |

## Pipeline

```
1 ingest     fires (NASA FIRMS) · station AQI (CPCB) · weather (Open-Meteo) · CAMS (Copernicus)
2 validate   load raw tables · contracts per table · freshness
3 transform  station_daily → aqi_daily (CPCB method) · fires_daily by state · wind_daily · cams_daily
4 features   t0 → t0+h rows, only information known at t0
5 model      walk-forward backtest · live forecast (train on all history)
6 ledger     commit · verify chain · grade settled forecasts
7 insights   findings · GRAP decision table · AI brief · agent eval
8 export     site/data/*.json
```

Every step records rows in/out, checks, freshness and duration in `data/runs/run_*.json`. The site's Pipeline row is drawn from these.

**AQI method.** CPCB: 24-hour mean PM2.5 and PM10 → sub-indices → station AQI = max; city AQI = mean of stations with ≥16 valid hours. The station exports carry PM2.5 and PM10 only, which dominate Delhi's winter AQI; other pollutants are not included.

## Run it

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

**Offline test (no downloads):** `python -m vp run --synthetic --mode history --no-llm`
Synthetic runs live in `data/synthetic/` and never touch real data or the public ledger. The site shows a banner.

**Real data, first time:**
1. Station data: download the Delhi station CSVs from [OpenCity · Delhi Hourly Air Quality Reports](https://data.opencity.in/dataset/delhi-hourly-air-quality-reports) (CPCB source, public domain) into `data/raw/aqi_opencity/`.
2. State boundaries ship in `data/ref/india_states.geojson` (Natural Earth, public domain), so fires are assigned to Punjab or Haryana by real polygons.
3. `python -m vp run --mode history`
4. **Fire data fallback:** if the FIRMS yearly archive download fails, either set `FIRMS_MAP_KEY` (free, instant from FIRMS) or drop FIRMS archive CSVs into `data/raw/fires_manual/`.

**Daily:** `python -m vp run --mode daily` (GitHub Actions runs this at 06:00 IST).

Other commands: `python -m vp verify` · `python -m vp ask "Which week in 2024 had the worst smog?"` · `python -m vp eval`

**LLM (brief + agent):** any one of `GROQ_API_KEY`, `GEMINI_API_KEY`, or `GITHUB_TOKEN` (GitHub Models, free inside Actions).

## Deploy

1. Push to GitHub. Add the repo on Vercel; `vercel.json` serves `/site`.
2. Repo secrets (optional): `GROQ_API_KEY`, `FIRMS_MAP_KEY`.
3. Workflows: `daily.yml` (forecast + ledger), `ci.yml` (tests + synthetic pipeline), `nomad-qa.yml` (QA after each deploy).

## Results

Filled from real runs only. Numbers from synthetic runs are never reported.

| Metric (48h, walk-forward) | Value |
|---|---|
| MAE vs persistence | _pending real run_ |
| 80% band coverage | _pending_ |
| Severe days caught | _pending_ |
| Agent eval | _pending_ /25 |

## Data sources

NASA FIRMS VIIRS active fires · CPCB continuous monitoring stations (via OpenCity; OpenAQ open archive for recent days) · Open-Meteo historical and forecast weather · Copernicus Atmosphere Monitoring Service via Open-Meteo. Attribution required by each source applies.
