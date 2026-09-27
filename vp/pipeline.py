"""The pipeline: 8 stages, each step recorded in the run manifest.

  python -m vp run --mode history     full backfill (first run on a new machine)
  python -m vp run --mode daily       recent data + forecast + ledger commit (GitHub Actions)
  python -m vp run --mode build       skip ingest, rebuild everything downstream
  add --synthetic to generate realistic fake raw data instead of downloading (offline testing)
"""
from __future__ import annotations

import json
import subprocess
from datetime import date, timedelta

import pandas as pd

from . import agent, config as C, extras, features, geo, ingest, insights, ledger, model, warehouse
from .runner import Check, Run


def _git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=C.ROOT, text=True).strip()
    except Exception:
        return "local"


def run(mode: str = "daily", synthetic: bool = False, commit_ledger: bool = True, with_llm: bool = True) -> dict:
    R = Run(mode)
    today = date.today()
    ctx: dict = {}
    if synthetic and not C.SYNTHETIC:
        raise RuntimeError("use the CLI flag --synthetic (it sets VP_SYNTHETIC=1 before config loads)")

    # ───────── 1 · ingest ─────────
    if mode != "build":
        if synthetic:
            from . import synthetic as S
            with R.step("ingest", "synthetic raw data") as r:
                r.rows_out = S.generate(today)
                r.notes = "SYNTHETIC data for offline testing, not real observations"
                fc_files = sorted((C.RAW / "cams").glob("forecast_*.parquet"))
                if fc_files:
                    ctx["cams_fc"] = pd.read_parquet(fc_files[-1])
        elif mode == "history":
            yrs = list(range(int(C.HISTORY_START[:4]), today.year + 1))
            gap_from = None
            with R.step("ingest", "fires · FIRMS VIIRS archive") as r:
                df = ingest.fires_history(r, yrs); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "date")
                r.notes += f"state split: {geo.boundary_mode()}"
            with R.step("ingest", "station AQI · CPCB via OpenCity") as r:
                df = ingest.aqi_opencity(r); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
                gap_from = (pd.Timestamp(df.ts.max()).date() + timedelta(days=1)) if len(df) else None
            if gap_from and gap_from < today - timedelta(days=10):
                with R.step("ingest", "station AQI · OpenAQ archive (gap after CPCB export)") as r:
                    df = ingest.aqi_openaq(r, gap_from, today - timedelta(days=1), "openaq_gap")
                    r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
            with R.step("ingest", "weather · Open-Meteo archive") as r:
                df = ingest.weather_history(r, C.HISTORY_START, str(today - timedelta(days=2)))
                r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
            with R.step("ingest", "CAMS · analysis history") as r:
                df = ingest.cams_history(r, str(today - timedelta(days=1))); r.rows_out = len(df)
                r.freshness = ingest.latest_ts(df, "ts")
        if not synthetic:  # daily feeds (also run after a history backfill)
            with R.step("ingest", "fires · FIRMS live 7-day") as r:
                df = ingest.fires_live(r); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "date")
            with R.step("ingest", "station AQI · OpenAQ recent") as r:
                df = ingest.aqi_openaq_recent(r); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
            with R.step("ingest", "weather · Open-Meteo forecast") as r:
                df = ingest.weather_forecast(r); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
            with R.step("ingest", "CAMS · 5-day forecast snapshot") as r:
                df = ingest.cams_forecast(r); r.rows_out = len(df); r.freshness = ingest.latest_ts(df, "ts")
                ctx["cams_fc"] = df

    con = warehouse.connect()

    # ───────── 2 · validate ─────────
    with R.step("validate", "load raw tables") as r:
        counts = warehouse.load_raw(con, r)
        r.checks = [Check(f"{t} not empty", n > 0, f"rows={n}", "error" if t in ("raw_aqi",) else "warn")
                    for t, n in counts.items()]
    for t in ("raw_aqi", "raw_fires", "raw_weather", "raw_cams"):
        with R.step("validate", f"contracts · {t}") as r:
            r.checks = warehouse.run_contracts(con, t)
            col = {"raw_fires": "date"}.get(t, "ts")
            r.checks.append(warehouse.freshness_check(con, t, col, 3 if mode == "daily" else 10_000))
            r.rows_in = counts.get(t)

    if R.failed:
        return _halt(R, "validate")

    # ───────── 3 · transform ─────────
    for name in warehouse.TRANSFORMS:
        with R.step("transform", name) as r:
            r.rows_out = warehouse.transform(con, name)
            if name == "aqi_daily":
                r.checks.append(Check("≥ 365 city-days", r.rows_out >= 365, f"days={r.rows_out}", "error"))
                r.freshness = str(con.execute("select max(date) from aqi_daily").fetchone()[0])
    with R.step("transform", "agent views") as r:
        warehouse.create_views(con)

    if R.failed:
        return _halt(R, "transform")

    # ───────── 4 · features ─────────
    with R.step("features", "daily frame") as r:
        daily = features.daily_frame(con); r.rows_out = len(daily)
    with R.step("features", "feature table (t0 → t0+h)") as r:
        feats = features.build(daily, tuple(h // 24 for h in C.HORIZONS_H)); r.rows_out = len(feats)
        miss = feats[features.FEATURES].isna().mean().max()
        r.checks.append(Check("max feature null share < 30%", miss < 0.3, f"{miss:.1%}", "warn"))
        con.register("feats_df", feats)
        con.execute("create or replace table features as select * from feats_df")

    if R.failed:
        return _halt(R, "features")

    # ───────── 5 · model ─────────
    with R.step("model", "walk-forward backtest") as r:
        bt = model.backtest(feats); r.rows_out = len(bt)
        con.register("bt_df", bt)
        con.execute("create or replace table backtest as select * from bt_df")
        con.execute("create or replace view v_forecasts as select issue_date::date issue_date, target_date::date target_date, "
                    "horizon_h, p10, p50, p90, p_severe, actual, season from backtest")
        ctx["metrics"] = model.metrics(bt)
        ctx["calibration"] = model.calibration(bt)
        o = ctx["metrics"].get("overall_48h", {})
        r.checks.append(Check("beats persistence at 48h", (o.get("skill_vs_persistence") or -1) > 0,
                              f"skill={o.get('skill_vs_persistence')}", "warn"))
        r.checks.append(Check("80% band covers 70–90%", 0.7 <= (o.get("coverage_80") or 0) <= 0.9,
                              f"coverage={o.get('coverage_80')}", "warn"))
    with R.step("model", "live forecast (train on all history)") as r:
        fc_all, expl, imps = model.live_forecast(feats); r.rows_out = len(fc_all)
        # Only targets that are still in the future count as forecasts (the archive lags 1-3 days).
        issued = pd.Timestamp(ledger.today_ist())
        fc = fc_all[fc_all.target_date > issued].sort_values("horizon_h").head(3)
        r.checks.append(Check("three future targets", len(fc) == 3,
                              f"obs to {str(fc_all.issue_date.max())[:10]}, issued {issued:%Y-%m-%d}", "warn"))
        if not len(fc):
            fc = fc_all.sort_values("horizon_h").tail(3)
        ctx |= {"forecast": fc, "forecast_all": fc_all, "explain": expl, "importance": imps,
                "issued_on": f"{issued:%Y-%m-%d}"}
        r.freshness = str(fc_all.issue_date.max())[:10]

    if R.failed:
        return _halt(R, "model")

    # ───────── 6 · ledger ─────────
    with R.step("ledger", "commit forecasts") as r:
        run_date, obs_date = ctx["issued_on"], str(fc.issue_date.max())[:10]
        rows = [{"source": "vayu", "issue_date": run_date, "obs_date": obs_date, "target_date": str(x.target_date)[:10],
                 "horizon_h": int(x.horizon_h), "p10": float(x.p10), "p50": float(x.p50), "p90": float(x.p90),
                 "p_severe": float(x.p_severe)} for x in fc.itertuples()]
        cams = ctx.get("cams_fc")
        if cams is None:
            fc_files = sorted((C.RAW / "cams").glob("forecast_*.parquet"))
            cams = pd.read_parquet(fc_files[-1]) if fc_files else None
            if cams is not None and str(cams.issued.iloc[0])[:10] != str(fc.issue_date.max())[:10] and \
                    (pd.Timestamp(cams.issued.iloc[0]) - fc.issue_date.max()).days > 1:
                cams = None  # stale snapshot: don't pair it with today's forecast
        if cams is not None and len(cams):
            cd = cams.assign(date=cams.ts.dt.date).groupby("date")[["pm25", "pm10"]].mean().reset_index()
            targets = {str(t)[:10] for t in fc.target_date}
            for x in cd.itertuples():
                h = (pd.Timestamp(x.date) - pd.Timestamp(str(cams.issued.iloc[0])[:10])).days * 24
                if str(x.date) in targets:
                    aqi = con.execute("select round(greatest(si_pm25(?), coalesce(si_pm10(?),0)))", [x.pm25, x.pm10]).fetchone()[0]
                    rows.append({"source": "cams", "issue_date": run_date, "target_date": str(x.date),
                                 "horizon_h": h, "p50": float(aqi)})
        if commit_ledger:
            try:
                block = ledger.commit(rows, run_date, _git_sha())
                r.notes = f"block #{block['height']} root {block['root'][:12]}…"
            except RuntimeError as e:
                r.status, r.notes = "skipped", str(e)
        r.rows_out = len(rows)
    with R.step("ledger", "verify chain") as r:
        v = ledger.verify(); ctx["verify"] = v
        r.checks.append(Check("chain intact", v["ok"], "; ".join(v["problems"]) or f"{v['blocks']} blocks", "error"))
    with R.step("ledger", "grade settled forecasts") as r:
        graded = ledger.grade(con); ctx["graded"] = graded; r.rows_out = len(graded)

    # ───────── 7 · insights ─────────
    with R.step("insights", "smog findings (6 queries)") as r:
        ctx["findings"] = insights.run_findings(con)
        bad = [f["id"] for f in ctx["findings"] if "error" in f]
        r.checks.append(Check("all findings ran", not bad, ", ".join(bad) or "6/6", "warn")); r.rows_out = 6 - len(bad)
    with R.step("insights", "GRAP decision table") as r:
        ctx["decision"] = insights.decision_table(bt)
        ctx["grap_call"] = insights.grap_call(fc, 0.3); r.rows_out = len(ctx["decision"].get("thresholds", []))
    with R.step("insights", "what-if grid (live models)") as r:
        ctx["whatif"] = extras.whatif_grid({int(h) for h in ctx["forecast"].horizon_h})
        r.rows_out = sum(len(v["grid"]) for v in ctx["whatif"]["horizons"].values())
    with R.step("insights", "model arena") as r:
        ctx["arena"] = extras.arena(con, bt); r.rows_out = sum(len(h["rows"]) for h in ctx["arena"].get("horizons", []))
    with R.step("insights", "drift monitor (seasonal PSI)") as r:
        ctx["drift"] = extras.drift(feats, bt, ctx.get("graded")); r.rows_out = len(ctx["drift"]["features"])
        drifted = [f["feature"] for f in ctx["drift"]["features"] if f["status"] == "drift"]
        r.checks.append(Check("no feature drift (PSI ≤ 0.25)", not drifted, ", ".join(drifted) or "all stable", "warn"))
    con.close()
    ro = agent.readonly_con()
    with R.step("insights", "daily AI brief") as r:
        ctx["brief"] = {"text": "", "generated_by": "skipped"}  # export still runs if the brief fails
        facts = insights.brief_facts(ro, fc, expl)
        ctx["brief"] = agent.brief(facts) if with_llm else ctx["brief"]
        ctx["brief"]["facts"] = facts
        if "template" in ctx["brief"]["generated_by"]:
            r.status = "warn"
    with R.step("insights", "agent eval (25 questions)") as r:
        if with_llm and agent.provider():
            ctx["eval"] = agent.run_eval(ro); r.rows_out = ctx["eval"]["total"]
            r.checks.append(Check("eval ≥ 80%", ctx["eval"]["passed"] >= 20, f"{ctx['eval']['passed']}/25", "warn"))
        else:
            ctx["eval"] = _eval_reference_only(ro); r.status = "skipped"; r.notes = "no LLM key: reference answers only"
    ro.close()

    # ───────── 8 · export ─────────
    with R.step("export", "site JSON") as r:
        from . import export
        r.rows_out = export.write_all(ctx, R)
    with R.step("export", "public API v1 + catalog") as r:
        from . import export
        r.rows_out = export.write_api(ctx)
    with R.step("export", "lineage graph") as r:
        from . import export
        r.rows_out = export.write_lineage(R)
    doc = R.save()
    from . import export
    export.write_manifest(doc)
    return doc


def _halt(R: Run, stage: str) -> dict:
    """A failed stage stops the run: later stages would only build on bad data."""
    from . import export
    from .runner import STAGES, StepResult
    for st in STAGES[STAGES.index(stage) + 1:]:
        R.steps.append(StepResult(stage=st, step="(not run)", status="skipped", notes=f"halted after {stage} failed"))
    doc = R.save()
    export.write_manifest(doc)
    print(f"HALTED after {stage}")
    return doc


def _eval_reference_only(con) -> dict:
    out = []
    for it in agent.load_eval():
        try:
            df = agent.run_sql(con, it["reference_sql"])
            out.append({"id": it["id"], "category": it["category"], "question": it["question"],
                        "sql": it["reference_sql"], "columns": list(df.columns),
                        "rows": agent.to_rows(df, 20),
                        "passed": None, "answer": None})
        except Exception as e:
            out.append({"id": it["id"], "category": it["category"], "question": it["question"], "error": str(e)})
    return {"passed": None, "total": len(out), "by_category": {}, "model": None, "results": out}
