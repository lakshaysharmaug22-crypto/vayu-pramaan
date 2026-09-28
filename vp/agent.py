"""Ask Vayu: text-to-SQL analyst agent with guardrails, plus the daily AI brief.

Provider: any OpenAI-compatible endpoint, picked from env in this order:
  GROQ_API_KEY (Groq), then GEMINI_API_KEY (Gemini). Both have free tiers.
Guardrails: read-only DuckDB connection, whitelisted views, single SELECT/WITH statement,
blocked keywords, forced LIMIT, and the SQL is always returned with the answer.
"""
from __future__ import annotations

import json
import os
import re
import time

import duckdb
import pandas as pd
import requests

from . import config as C

VIEWS = {
    "v_aqi_daily": "date, aqi (CPCB city AQI), pm25, pm10, band, grap, n_stations",
    "v_station_daily": "station, date, pm25, pm10, hours, aqi",
    "v_fires_upwind": "date, fires (VIIRS detections Punjab+Haryana), fires_punjab, fires_haryana, frp_sum",
    "v_wind_daily": "date, wind_speed (m/s, Delhi), wind_dir (deg), nw_frac (share of hours with NW wind, Delhi), "
                    "nw_frac_upwind (Ludhiana), blh (boundary layer m), blh_min, temp, rh, precip",
    "v_cams_daily": "date, aqi_equiv (CAMS model AQI), pm25, pm10",
    "v_forecasts": "issue_date, target_date, horizon_h, p10, p50, p90, p_severe, actual, season (walk-forward backtest)",
}
BLOCKED = re.compile(r"\b(insert|update|delete|drop|create|alter|attach|copy|pragma|install|load|export|call|set)\b|read_\w+\(|glob\(", re.I)
MAX_ROWS = 1000

SYSTEM = f"""You are the analyst agent for Vayu Pramaan, a Delhi air-quality observatory.
Write ONE DuckDB SQL query that answers the question using only these views:
{chr(10).join(f'- {k}({v})' for k, v in VIEWS.items())}
Rules: SELECT or WITH only. No other tables. Dates are DATE type. Severe means aqi > 400.
The burning season is October-November. Return JSON: {{"sql": "...", "why": "one line on approach"}}"""

EXPLAIN = """You explain query results for Vayu Pramaan in 2-3 plain sentences.
Use only numbers present in the result rows. No speculation beyond the data. No preamble."""


def provider() -> tuple[str, str, str] | None:
    if os.getenv("GROQ_API_KEY"):
        return "https://api.groq.com/openai/v1/chat/completions", os.environ["GROQ_API_KEY"], "llama-3.3-70b-versatile"
    if os.getenv("GEMINI_API_KEY"):
        return ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                os.environ["GEMINI_API_KEY"], "gemini-2.0-flash")
    return None


_last_call = [0.0]


def _min_gap() -> float:
    """Free tiers cap requests per minute (Groq ~30, Gemini ~15); pace calls rather than hit 429s."""
    p = provider()
    return 0.0 if not p else 4.2 if "googleapis" in p[0] else 2.1


def llm(system: str, user: str, json_mode: bool = False) -> str:
    p = provider()
    if not p:
        raise RuntimeError("no LLM provider configured (set GROQ_API_KEY or GEMINI_API_KEY)")
    url, key, model = p
    body = {"model": model, "temperature": 0, "messages": [{"role": "system", "content": system},
                                                           {"role": "user", "content": user}]}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    err = ""
    for i in range(4):
        wait = _last_call[0] + _min_gap() - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.monotonic()
        try:
            r = requests.post(url, json=body, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, timeout=60)
        except requests.RequestException as e:
            err = f"network: {e}"; time.sleep(2 ** i); continue
        if r.status_code == 200:
            try:
                content = r.json()["choices"][0]["message"]["content"] or ""
            except (ValueError, KeyError, IndexError):
                err = f"200 but unreadable body: {r.text[:160]!r}"; time.sleep(2 ** i); continue
            if content.strip():
                return content
            err = "empty completion"; time.sleep(2 ** i); continue
        err = f"{r.status_code} {r.text[:200]}"
        retry = r.headers.get("retry-after")
        time.sleep(min(float(retry), 60) if retry and retry.replace(".", "").isdigit() else 2 ** (i + 1))
    raise RuntimeError(f"LLM call failed: {err}")


def parse_json(text: str) -> dict:
    """Models sometimes wrap JSON in ```json fences or add a sentence; take the outermost object."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        a, b = t.find("{"), t.rfind("}")
        if a >= 0 and b > a:
            return json.loads(t[a:b + 1])
        raise ValueError(f"model did not return JSON: {text[:120]!r}")


def guard(sql: str) -> str:
    s = sql.strip().rstrip(";").strip()
    if ";" in s:
        raise ValueError("only one statement is allowed")
    if not re.match(r"^(select|with)\b", s, re.I):
        raise ValueError("query must start with SELECT or WITH")
    if BLOCKED.search(s):
        raise ValueError("query uses a blocked keyword or function")
    tables = set(re.findall(r"\b(?:from|join)\s+([a-z_][a-z0-9_]*)", s, re.I))
    ctes = set(re.findall(r"\b([a-z_][a-z0-9_]*)\s+as\s*\(", s, re.I))
    bad = {t for t in tables - ctes if t.lower() not in VIEWS and t.lower() not in ("range", "unnest")}
    if bad:
        raise ValueError(f"not a whitelisted view: {', '.join(sorted(bad))}")
    return f"select * from ({s}) limit {MAX_ROWS}"


def run_sql(con, sql: str) -> pd.DataFrame:
    return con.execute(guard(sql)).df()


def to_rows(df: pd.DataFrame, n: int = 50) -> list[dict]:
    d = df.head(n).copy()
    for c in d.columns:
        if pd.api.types.is_datetime64_any_dtype(d[c]):
            d[c] = d[c].dt.strftime("%Y-%m-%d")
    return json.loads(d.to_json(orient="records"))


def ask(con, question: str) -> dict:
    steps, t0 = [], time.perf_counter()
    plan = parse_json(llm(SYSTEM, question, json_mode=True))
    steps.append("write_sql")
    sql = plan["sql"]
    try:
        df = run_sql(con, sql)
    except Exception as e:  # one repair attempt with the error message
        steps.append("repair")
        plan = parse_json(llm(SYSTEM, f"{question}\nYour previous SQL failed with: {e}\nSQL was: {sql}", json_mode=True))
        sql = plan["sql"]
        df = run_sql(con, sql)
    steps.append("run")
    rows = to_rows(df)
    answer = llm(EXPLAIN, f"Question: {question}\nRows: {json.dumps(rows, default=str)[:6000]}")
    steps.append("explain")
    return {"question": question, "sql": sql, "why": plan.get("why", ""), "columns": list(df.columns),
            "rows": rows, "answer": answer, "steps": steps, "latency_s": round(time.perf_counter() - t0, 2)}


def brief(facts: dict) -> dict:
    prompt = ("Write a 3-paragraph daily brief (max 110 words) about tomorrow and the next 3 days of Delhi air. "
              "Paragraph 1: the headline forecast with its range and P(severe). Paragraph 2: the drivers, citing the "
              "numbers given. Paragraph 3: confidence and what could change it. Only use these facts:\n" + json.dumps(facts, default=str))
    try:
        return {"text": llm(EXPLAIN, prompt), "generated_by": provider()[2]}
    except Exception as e:
        f = facts["forecast"][0] if facts.get("forecast") else {}
        return {"text": f"Forecast AQI {f.get('p50')} for {f.get('target_date')} (range {f.get('p10')}–{f.get('p90')}), "
                        f"P(severe) {round((f.get('p_severe') or 0) * 100)}%.", "generated_by": f"template (LLM unavailable: {e})"}


# ---- eval ----
def load_eval() -> list[dict]:
    return json.loads((C.ROOT / "eval" / "questions.json").read_text())


def _same(a: pd.DataFrame, b: pd.DataFrame) -> bool:
    if a.shape[0] != b.shape[0]:
        return False
    na = a.select_dtypes("number").round(1)
    nb = b.select_dtypes("number").round(1)
    if na.shape[1] == 0 or nb.shape[1] == 0:
        return a.astype(str).values.tolist() == b.astype(str).values.tolist()
    # compare the multiset of numeric values, ignoring column names/order
    return sorted(map(tuple, na.fillna(-1).values.tolist())) == sorted(map(tuple, nb.fillna(-1).values.tolist())) or \
        sorted(na.fillna(-1).values.ravel().tolist()) == sorted(nb.fillna(-1).values.ravel().tolist())


def run_eval(con) -> dict:
    items, results = load_eval(), []
    for it in items:
        rec = {"id": it["id"], "category": it["category"], "question": it["question"]}
        try:
            ref = run_sql(con, it["reference_sql"])
            got = ask(con, it["question"])
            rec |= {"passed": _same(pd.DataFrame(got["rows"]), ref.head(50)), "sql": got["sql"], "answer": got["answer"],
                    "latency_s": got["latency_s"], "rows": got["rows"][:20], "columns": got["columns"]}
        except Exception as e:
            rec |= {"passed": False, "error": str(e)[:300]}
        results.append(rec)
    by_cat = {}
    for r in results:
        c = by_cat.setdefault(r["category"], {"passed": 0, "total": 0})
        c["total"] += 1
        c["passed"] += int(r["passed"])
    return {"passed": sum(r["passed"] for r in results), "total": len(results), "by_category": by_cat,
            "model": provider()[2] if provider() else None, "results": results}


def readonly_con() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(C.DB_PATH.as_posix(), read_only=True)
