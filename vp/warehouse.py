"""Stages 2-3 · Validate + Transform, all in DuckDB.

Raw parquet → raw_* tables → contract checks → curated daily tables → agent views.
AQI follows the CPCB method: 24h mean PM2.5 and PM10 → sub-indices → station AQI = max;
city AQI = mean of station AQIs (stations with ≥16 valid hours).
PM2.5 and PM10 dominate Delhi's winter AQI; other pollutants are not in the station exports,
which the README states.
"""
from __future__ import annotations

import duckdb

from . import config as C
from .runner import Check

RAW = C.RAW.as_posix()


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(C.DB_PATH.as_posix(), read_only=read_only)
    if not read_only:
        con.execute(MACROS)
    return con


MACROS = """
create or replace macro si_pm25(c) as case
  when c is null then null
  when c <= 30  then c * 50 / 30
  when c <= 60  then 50  + (c - 30)  * 50  / 30
  when c <= 90  then 100 + (c - 60)  * 100 / 30
  when c <= 120 then 200 + (c - 90)  * 100 / 30
  when c <= 250 then 300 + (c - 120) * 100 / 130
  else least(500, 400 + (c - 250) * 100 / 130) end;
create or replace macro si_pm10(c) as case
  when c is null then null
  when c <= 100 then c
  when c <= 250 then 100 + (c - 100) * 100 / 150
  when c <= 350 then 200 + (c - 250)
  when c <= 430 then 300 + (c - 350) * 100 / 80
  else least(500, 400 + (c - 430) * 100 / 80) end;
create or replace macro aqi_band(a) as case
  when a is null then null when a <= 50 then 'Good' when a <= 100 then 'Satisfactory'
  when a <= 200 then 'Moderate' when a <= 300 then 'Poor' when a <= 400 then 'Very poor' else 'Severe' end;
create or replace macro grap_stage(a) as case
  when a is null then null when a > 450 then 'Stage IV' when a > 400 then 'Stage III'
  when a > 300 then 'Stage II' when a > 200 then 'Stage I' else 'None' end;
"""


def _glob(source: str) -> str | None:
    p = C.RAW / source
    return f"{RAW}/{source}/*.parquet" if p.exists() and any(p.glob("*.parquet")) else None


def load_raw(con, res) -> dict[str, int]:
    counts = {}
    g = _glob("fires")
    con.execute(f"""create or replace table raw_fires as
        select distinct on (date, time_utc, round(lat,4), round(lon,4), satellite) *
        from {f"read_parquet('{g}', union_by_name=true)" if g else
              "(select null::date date, null::varchar time_utc, null::double lat, null::double lon, null::double frp, null::varchar confidence, null::varchar satellite, null::varchar state where false)"}""")
    g = _glob("aqi")
    has_aqi = bool(g) and "aqi" in set(con.execute(f"describe select * from read_parquet('{g}', union_by_name=true)").df().column_name)
    aqi_expr = "avg(aqi)::double" if has_aqi else "null::double"
    con.execute(f"""create or replace table raw_aqi as
        select station, ts::timestamp ts, avg(pm25)::double pm25, avg(pm10)::double pm10, {aqi_expr} aqi
        from read_parquet('{g}', union_by_name=true) group by 1,2""" if g else
                "create or replace table raw_aqi (station varchar, ts timestamp, pm25 double, pm10 double, aqi double)")
    g = _glob("weather")
    # Prefer archive (hist_) rows over forecast rows for the same hour; among forecasts, the newest file.
    con.execute(f"""create or replace table raw_weather as
        select * exclude (filename, prio) from (
          select *, case when filename like '%hist_%' then 1 else 0 end prio
          from read_parquet('{g}', union_by_name=true, filename=true))
        qualify row_number() over (partition by site, ts order by prio desc, filename desc) = 1""" if g else
                "create or replace table raw_weather (site varchar, ts timestamp, wind_speed double, wind_dir double, temp double, rh double, precip double, blh double)")
    g = _glob("cams")
    con.execute(f"""create or replace table raw_cams as
        select kind, issued::date issued, ts::timestamp ts, pm25::double pm25, pm10::double pm10
        from read_parquet('{g}', union_by_name=true)""" if g else
                "create or replace table raw_cams (kind varchar, issued date, ts timestamp, pm25 double, pm10 double)")
    for t in ("raw_fires", "raw_aqi", "raw_weather", "raw_cams"):
        counts[t] = con.execute(f"select count(*) from {t}").fetchone()[0]
    res.rows_out = sum(counts.values())
    return counts


# ───────────── contracts ─────────────
CONTRACTS = {
    "raw_aqi": [
        ("pm25 within 0–1500 µg/m³", "select count(*) from raw_aqi where pm25 < 0 or pm25 > 1500", 0, "warn"),
        ("pm10 within 0–2000 µg/m³", "select count(*) from raw_aqi where pm10 < 0 or pm10 > 2000", 0, "warn"),
        ("no duplicate station-hours", "select count(*) - count(distinct (station, ts)) from raw_aqi", 0, "error"),
        ("≥ 5 stations reporting", "select 5 - count(distinct station) from raw_aqi", 0, "error"),
        ("PM2.5 or CPCB AQI present in ≥ 60% of rows", "select (avg(case when pm25 is null and aqi is null then 1 else 0 end) * 100)::int - 39 from raw_aqi", 0, "warn"),
    ],
    "raw_fires": [
        ("inside Punjab–Haryana bbox",
         f"select count(*) from raw_fires where lat not between {C.FIRE_BBOX['south']} and {C.FIRE_BBOX['north']} "
         f"or lon not between {C.FIRE_BBOX['west']} and {C.FIRE_BBOX['east']}", 0, "error"),
        ("fire radiative power ≥ 0", "select count(*) from raw_fires where frp < 0", 0, "warn"),
        ("state assigned", "select count(*) from raw_fires where state is null", 0, "warn"),
    ],
    "raw_weather": [
        ("wind direction 0–360°", "select count(*) from raw_weather where wind_dir < 0 or wind_dir > 360", 0, "error"),
        ("wind speed ≥ 0", "select count(*) from raw_weather where wind_speed < 0", 0, "error"),
        ("both sites present", "select 2 - count(distinct site) from raw_weather", 0, "error"),
    ],
    "raw_cams": [
        ("non-negative concentrations", "select count(*) from raw_cams where pm25 < 0 or pm10 < 0", 0, "warn"),
    ],
}


def run_contracts(con, table: str) -> list[Check]:
    checks = []
    for name, sql, ok_max, sev in CONTRACTS[table]:
        try:
            v = con.execute(sql).fetchone()[0] or 0
            checks.append(Check(name, v <= ok_max, f"violations={max(v, 0)}", sev))
        except Exception as e:
            checks.append(Check(name, False, f"query failed: {e}", sev))
    return checks


def freshness_check(con, table: str, col: str, max_age_days: int) -> Check:
    latest = con.execute(f"select max({col})::date from {table}").fetchone()[0]
    if latest is None:
        return Check(f"{table} fresh within {max_age_days}d", False, "empty", "warn")
    age = con.execute(f"select current_date - '{latest}'::date").fetchone()[0]
    return Check(f"{table} fresh within {max_age_days}d", age <= max_age_days, f"latest={latest} age={age}d", "warn")


# ───────────── transforms ─────────────
TRANSFORMS = {
    "station_daily": """
        create or replace table station_daily as
        select station, ts::date as date,
               avg(pm25) pm25, avg(pm10) pm10, greatest(count(pm25), count(aqi)) as hours,
               case when count(pm25) >= 16 then greatest(si_pm25(avg(pm25)), coalesce(si_pm10(avg(pm10)), 0))
                    else avg(aqi) end aqi,
               case when count(pm25) >= 16 then 'concentrations' else 'cpcb_hourly_aqi' end as method
        from raw_aqi group by 1, 2 having count(pm25) >= 16 or count(aqi) >= 16""",
    # City AQI = mean of station AQIs on days with enough stations. On days with too few stations
    # (recent days served by a single open-archive station), each station is scaled by its median
    # ratio to the city AQI over days both existed, and the day is flagged proxy = true.
    "aqi_daily": f"""
        create or replace table aqi_daily as
        with full_days as (
            select date, avg(aqi) aqi, avg(pm25) pm25, avg(pm10) pm10, count(*) n
            from station_daily group by date having count(*) >= {C.MIN_STATIONS_PER_DAY}),
        ratio as (
            select s.station, median(f.aqi / nullif(s.aqi, 0)) r
            from station_daily s join full_days f using (date) group by s.station having count(*) >= 60),
        proxy_days as (
            select s.date, avg(s.aqi * r.r) aqi, avg(s.pm25) pm25, avg(s.pm10) pm10, count(*) n
            from station_daily s join ratio r using (station)
            where s.date not in (select date from full_days) group by s.date)
        select date, round(aqi)::int aqi, round(pm25, 1) pm25, round(pm10, 1) pm10, n n_stations, false proxy,
               aqi_band(aqi) band, grap_stage(aqi) grap from full_days
        union all
        select date, round(aqi)::int, round(pm25, 1), round(pm10, 1), n, true, aqi_band(aqi), grap_stage(aqi) from proxy_days
        order by date""",
    "aqi_hourly_city": """
        create or replace table aqi_hourly_city as
        select ts, round(avg(pm25),1) pm25, round(avg(pm10),1) pm10, count(*) n_stations
        from raw_aqi group by ts order by ts""",
    "fires_daily": """
        create or replace table fires_daily as
        with d as (select range::date date from range(
            (select coalesce(min(date), current_date) from raw_fires)::timestamp,
            (select coalesce(max(date), current_date) from raw_fires)::timestamp + interval 1 day, interval 1 day))
        select d.date,
               count(f.lat) fires,
               count(f.lat) filter (where f.state = 'Punjab') fires_punjab,
               count(f.lat) filter (where f.state = 'Haryana') fires_haryana,
               round(coalesce(sum(f.frp), 0), 1) frp_sum
        from d left join raw_fires f on f.date = d.date group by d.date order by d.date""",
    "wind_daily": f"""
        create or replace table wind_daily as
        select ts::date date,
               round(avg(wind_speed) filter (where site='delhi'), 2) wind_speed,
               round((degrees(atan2(avg(sin(radians(wind_dir))) filter (where site='delhi'),
                                    avg(cos(radians(wind_dir))) filter (where site='delhi'))) + 360) % 360) wind_dir,
               round(avg(case when wind_dir between {C.NW_DIR_MIN} and {C.NW_DIR_MAX} then 1.0 else 0 end)
                     filter (where site='delhi'), 3) nw_frac,
               round(avg(case when wind_dir between {C.NW_DIR_MIN} and {C.NW_DIR_MAX} then 1.0 else 0 end)
                     filter (where site='ludhiana'), 3) nw_frac_upwind,
               round(avg(blh) filter (where site='delhi'), 0) blh,
               round(min(blh) filter (where site='delhi'), 0) blh_min,
               round(avg(temp) filter (where site='delhi'), 1) as temp,
               round(avg(rh) filter (where site='delhi'), 1) as rh,
               round(sum(precip) filter (where site='delhi'), 1) as precip
        from raw_weather group by 1 order by 1""",
    "cams_daily": """
        create or replace table cams_daily as
        select ts::date date, round(avg(pm25),1) pm25, round(avg(pm10),1) pm10,
               round(greatest(si_pm25(avg(pm25)), coalesce(si_pm10(avg(pm10)),0)))::int aqi
        from raw_cams where kind = 'analysis' group by 1 order by 1""",
    "cams_forecast_daily": """
        create or replace table cams_forecast_daily as
        select issued, ts::date date, (ts::date - issued) * 24 horizon_h,
               round(greatest(si_pm25(avg(pm25)), coalesce(si_pm10(avg(pm10)),0)))::int aqi
        from raw_cams where kind = 'forecast' group by 1, 2 order by 1, 2""",
}

VIEWS = """
create or replace view v_aqi_daily as select date, aqi, pm25, pm10, band, grap, n_stations, proxy from aqi_daily;
create or replace view v_station_daily as select * from station_daily;
create or replace view v_fires_upwind as select * from fires_daily;
create or replace view v_wind_daily as select * from wind_daily;
create or replace view v_cams_daily as select date, aqi as aqi_equiv, pm25, pm10 from cams_daily;
"""


def transform(con, name: str) -> int:
    con.execute(TRANSFORMS[name])
    return con.execute(f"select count(*) from {name}").fetchone()[0]


def create_views(con):
    con.execute(VIEWS)
