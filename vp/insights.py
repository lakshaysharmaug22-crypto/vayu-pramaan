"""Stage 7 · Insights. Data Analyst findings and the Business Analyst GRAP decision desk.

Every finding is one SQL query; the query text ships to the site next to its result.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C

FINDINGS = [
    {
        "id": "lag",
        "title": "How long does smoke take to reach Delhi?",
        "sql": """with d as (
  select a.date, a.aqi, f.fires
  from v_aqi_daily a join v_fires_upwind f using (date)
  where month(a.date) in (10, 11))
select k * 24 as lag_h,
       round(corr(aqi, fires_lag), 3) as r
from (select k, aqi, lag(fires, k) over (partition by k order by date) as fires_lag
      from d, range(0, 6) t(k))
group by k order by k""",
    },
    {
        "id": "wind",
        "title": "Does northwest wind make fire days worse?",
        "sql": f"""select case when w.nw_frac >= 0.5 then 'Northwest wind' else 'Other wind' end as wind,
       round(avg(a.aqi)) as avg_aqi, count(*) as days
from v_aqi_daily a
join v_wind_daily w on w.date = a.date
join v_fires_upwind f on f.date = a.date - 1
where f.fires >= (select quantile_cont(fires, 0.75) from v_fires_upwind
                  where month(date) in (10, 11) and fires > 0)
group by wind order by wind""",
    },
    {
        "id": "floor",
        "title": "What is Delhi's own pollution floor?",
        "sql": """select round(median(a.aqi)) as local_floor,
       round(quantile_cont(a.aqi, 0.25)) as p25,
       round(quantile_cont(a.aqi, 0.75)) as p75,
       count(*) as days
from v_aqi_daily a
join v_fires_upwind f on f.date = a.date - 1
where month(a.date) in (10, 11, 12) and f.fires < 20""",
    },
    {
        "id": "states",
        "title": "Which state drives the fires?",
        "sql": """select year(date) as season,
       sum(fires_punjab) as punjab, sum(fires_haryana) as haryana,
       round(sum(fires_punjab) * 100.0 / nullif(sum(fires), 0), 1) as punjab_pct
from v_fires_upwind
where month(date) in (10, 11)
group by season having sum(fires) > 0 order by season""",
    },
    {
        "id": "calendar",
        "title": "How big are the Diwali and weekend effects?",
        "sql": """with dw(d) as (values {diwali})
select case when exists (select 1 from dw where abs(a.date - dw.d::date) <= 1) then 'Diwali ±1 day'
            when dayofweek(a.date) in (0, 6) then 'Weekend'
            else 'Weekday' end as bucket,
       round(avg(a.aqi)) as avg_aqi, count(*) as days
from v_aqi_daily a
where month(a.date) in (10, 11)
group by bucket order by avg_aqi desc""",
    },
    {
        "id": "cams",
        "title": "Where does the global model miss?",
        "sql": """select count(*) filter (where c.aqi_equiv <= 400) as cams_missed,
       count(*) as severe_days,
       round(avg(a.aqi - c.aqi_equiv)) as avg_underestimate
from v_aqi_daily a
join v_cams_daily c on c.date = a.date
where a.aqi > 400""",
        "extra_sql": """select a.date, a.aqi as observed, c.aqi_equiv as cams
from v_aqi_daily a join v_cams_daily c on c.date = a.date
where month(a.date) in (10, 11) order by a.date""",
    },
]


def run_findings(con) -> list[dict]:
    diwali = ", ".join(f"('{v}')" for v in C.DIWALI.values())
    out = []
    for f in FINDINGS:
        sql = f["sql"].replace("{diwali}", diwali)
        item = {"id": f["id"], "title": f["title"], "sql": sql}
        try:
            df = con.execute(sql).df()
            item["rows"] = _records(df)
            if "extra_sql" in f:
                item["points"] = _records(con.execute(f["extra_sql"]).df())
            item["takeaway"] = _takeaway(f["id"], df)
        except Exception as e:
            item["error"] = str(e)
        out.append(item)
    return out


def _records(df: pd.DataFrame) -> list[dict]:
    return df.replace({np.nan: None}).astype(object).where(df.notna(), None).to_dict("records")


def _takeaway(fid: str, df: pd.DataFrame) -> str:
    if not len(df):
        return "Not enough data yet."
    if fid == "lag":
        best = df.loc[df.r.idxmax()]
        return f"Fire counts match Delhi AQI best {int(best.lag_h)} hours later (r = {best.r:.2f})."
    if fid == "wind":
        d = dict(zip(df.wind, df.avg_aqi))
        if len(d) == 2:
            nw, ot = d.get("Northwest wind"), d.get("Other wind")
            return f"After heavy-fire days, AQI averages {nw:.0f} with northwest wind vs {ot:.0f} otherwise, {nw - ot:+.0f} points."
    if fid == "floor":
        r = df.iloc[0]
        return f"With almost no farm fires, Delhi still sits at a median AQI of {r.local_floor:.0f} ({int(r.days)} days)."
    if fid == "states":
        a, b = df.iloc[0], df.iloc[-1]
        return f"Punjab's share of upwind fires moved from {a.punjab_pct:.0f}% in {int(a.season)} to {b.punjab_pct:.0f}% in {int(b.season)}."
    if fid == "calendar":
        d = dict(zip(df.bucket, df.avg_aqi))
        dw, wd, we = d.get("Diwali ±1 day"), d.get("Weekday"), d.get("Weekend")
        parts = []
        if dw and wd:
            parts.append(f"Diwali days average {dw:.0f} vs {wd:.0f} on other weekdays")
        if wd and we:
            parts.append(f"weekends run {wd - we:.0f} points lower")
        return (". ".join(parts) + ".").capitalize() if parts else ""
    if fid == "cams":
        r = df.iloc[0]
        return f"CAMS put {int(r.cams_missed)} of {int(r.severe_days)} severe days below 400, underestimating by {r.avg_underestimate or 0:.0f} AQI on average."
    return ""


# ───────────── GRAP decision desk ─────────────
def decision_table(bt: pd.DataFrame, horizon_h: int = 48) -> dict:
    """Confusion counts at every warning threshold, so the site can price any cost pair live."""
    g = bt[bt.horizon_h == horizon_h]
    if not len(g):
        return {}
    sev = (g.actual > C.SEVERE).to_numpy()
    p = g.p_severe.to_numpy()
    rows = []
    for th in np.round(np.arange(0.02, 0.99, 0.01), 2):
        w = p >= th
        rows.append({"threshold": float(th), "tp": int((w & sev).sum()), "fp": int((w & ~sev).sum()),
                     "fn": int((~w & sev).sum()), "tn": int((~w & ~sev).sum())})
    # lead time: for each severe episode start, how many hours earlier did a warning first appear
    return {"horizon_h": horizon_h, "days": int(len(g)), "severe_days": int(sev.sum()), "thresholds": rows}


def grap_call(forecast: pd.DataFrame, threshold: float) -> dict:
    top = forecast.sort_values("p_severe", ascending=False).iloc[0]
    act = top.p_severe >= threshold
    stage = next((s for lo, hi, s in C.GRAP_STAGES if lo <= top.p50 <= hi), "None")
    return {"act": bool(act), "stage": stage if act else "Hold", "target_date": str(top.target_date)[:10],
            "horizon_h": int(top.horizon_h), "p_severe": float(top.p_severe), "p50": float(top.p50),
            "p10": float(top.p10), "p90": float(top.p90), "threshold": threshold}


# ───────────── daily brief facts (the LLM writes prose only from these) ─────────────
def brief_facts(con, forecast: pd.DataFrame, explain: dict) -> dict:
    last = con.execute("select * from v_aqi_daily order by date desc limit 1").df()
    fires = con.execute("select date, fires from v_fires_upwind order by date desc limit 4").df()
    wind = con.execute("select * from v_wind_daily order by date desc limit 1").df()
    return {
        "latest_observed": _records(last)[0] if len(last) else None,
        "fires_last_4_days": _records(fires),
        "wind_today": _records(wind)[0] if len(wind) else None,
        "forecast": _records(forecast[["target_date", "horizon_h", "p10", "p50", "p90", "p_severe"]]
                             .assign(target_date=lambda d: d.target_date.astype(str).str[:10])),
        "top_drivers_48h": explain.get(48, []),
    }
