"""Stage 5 · Model. Quantile LightGBM per horizon, walk-forward backtest, live forecast.

P(severe) comes from the forecast distribution itself (a normal fitted to p10/p50/p90),
so the probability and the band always agree.
"""
from __future__ import annotations

import json
import math

import lightgbm as lgb
import numpy as np
import pandas as pd

from . import config as C
from .features import FEATURES

QUANTILES = (0.1, 0.5, 0.9)
PARAMS = dict(objective="quantile", learning_rate=0.03, n_estimators=500, num_leaves=15,
              min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
              reg_lambda=1.0, verbose=-1)
MODEL_DIR = C.DATA / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
Z90 = 1.2815515655446004


def _fit_raw(tr: pd.DataFrame) -> dict:
    models = {}
    for q in QUANTILES:
        m = lgb.LGBMRegressor(alpha=q, **PARAMS)
        m.fit(tr[FEATURES], tr["target"])
        models[q] = m
    return models


def fit(train: pd.DataFrame, conformal: bool = True) -> dict:
    """Quantile models + split-conformal correction (CQR, Romano et al. 2019).

    Fit on the earliest 80% of training days, measure how far truth falls outside the
    p10–p90 band on the latest 20%, then refit on everything and widen/narrow the band
    by that amount so the 80% band really covers ~80%.
    """
    tr = train.dropna(subset=["target"]).sort_values("target_date")
    adj = 0.0
    if conformal and len(tr) > 300:
        cut = int(len(tr) * 0.8)
        fit_part, cal = tr.iloc[:cut], tr.iloc[cut:]
        m0 = _fit_raw(fit_part)
        lo, hi = m0[0.1].predict(cal[FEATURES]), m0[0.9].predict(cal[FEATURES])
        scores = np.maximum(lo - cal["target"].to_numpy(), cal["target"].to_numpy() - hi)
        n = len(scores)
        adj = float(np.quantile(scores, min(1.0, np.ceil((n + 1) * 0.8) / n)))
    models = _fit_raw(tr)
    models["_adj"] = adj
    return models


def _phi(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def predict(models, X: pd.DataFrame) -> pd.DataFrame:
    P = np.column_stack([models[q].predict(X[FEATURES]) for q in QUANTILES])
    P.sort(axis=1)  # guarantee p10 ≤ p50 ≤ p90
    adj = models.get("_adj", 0.0)
    p10, p50, p90 = np.minimum(P[:, 0] - adj, P[:, 1]), P[:, 1], np.maximum(P[:, 2] + adj, P[:, 1])
    sigma = np.maximum((p90 - p10) / (2 * Z90), 5.0)
    p_sev = 1 - _phi((C.SEVERE - p50) / sigma)
    p_vp = 1 - _phi((300 - p50) / sigma)
    return pd.DataFrame({"p10": p10.round(), "p50": p50.round(), "p90": p90.round(),
                         "p_severe": p_sev.round(3), "p_very_poor": p_vp.round(3)}, index=X.index)


def importance(models) -> list[dict]:
    m = models[0.5]
    imp = pd.Series(m.booster_.feature_importance("gain"), index=FEATURES)
    imp = (imp / imp.sum()).sort_values(ascending=False)
    return [{"feature": k, "share": round(float(v), 4)} for k, v in imp.head(12).items()]


def explain_row(models, row: pd.DataFrame) -> list[dict]:
    """Per-feature contribution (SHAP) for one forecast, from LightGBM's built-in pred_contrib."""
    contrib = models[0.5].predict(row[FEATURES], pred_contrib=True)[0]
    pairs = sorted(zip(FEATURES, contrib[:-1]), key=lambda t: -abs(t[1]))[:6]
    return [{"feature": f, "aqi_points": round(float(v))} for f, v in pairs]


# ───────────── walk-forward backtest ─────────────
def backtest(feats: pd.DataFrame) -> pd.DataFrame:
    out = []
    for y in C.BACKTEST_SEASONS:
        start = pd.Timestamp(f"{y}-{C.SEASON_MONTHS[0]:02d}-01")
        end = pd.Timestamp(f"{y}-{C.SEASON_MONTHS[-1]:02d}-01") + pd.offsets.MonthEnd(0)
        test = feats[(feats.target_date >= start) & (feats.target_date <= end) & feats.target.notna()]
        if not len(test):
            continue
        for h in sorted(test.horizon_h.unique()):
            train = feats[(feats.horizon_h == h) & (feats.target_date < start)]
            if train.target.notna().sum() < 200:
                continue
            models = fit(train)
            th = test[test.horizon_h == h]
            pred = predict(models, th)
            clim = _climatology(train, th)
            out.append(pd.concat([th[["issue_date", "target_date", "horizon_h", "target", "aqi_0"]], pred], axis=1)
                       .assign(season=y, climatology=clim, ridge=ridge_fit_predict(train, th)))
    bt = pd.concat(out, ignore_index=True) if out else pd.DataFrame()
    if len(bt):
        bt = bt.rename(columns={"target": "actual", "aqi_0": "persistence"})
    return bt


def ridge_fit_predict(train: pd.DataFrame, test: pd.DataFrame, lam: float = 10.0) -> np.ndarray:
    """Linear challenger for the model arena: standardised ridge regression, closed form."""
    tr = train.dropna(subset=["target"])
    Xtr, Xte = tr[FEATURES].astype(float), test[FEATURES].astype(float)
    med = Xtr.median()
    Xtr, Xte = Xtr.fillna(med), Xte.fillna(med)
    mu, sd = Xtr.mean(), Xtr.std().replace(0, 1)
    A, B = ((Xtr - mu) / sd).to_numpy(), ((Xte - mu) / sd).to_numpy()
    y = tr["target"].to_numpy(float)
    ym = y.mean()
    w = np.linalg.solve(A.T @ A + lam * np.eye(A.shape[1]), A.T @ (y - ym))
    return np.round(B @ w + ym)


def _climatology(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    t = train.dropna(subset=["target"]).copy()
    t["md"] = t.target_date.dt.strftime("%m-%d")
    by_md = t.groupby("md")["target"].mean()
    # smooth ±7 days
    idx = pd.date_range("2001-01-01", "2001-12-31").strftime("%m-%d")
    s = by_md.reindex(idx).interpolate(limit_direction="both")
    s = pd.concat([s.iloc[-7:], s, s.iloc[:7]]).rolling(15, center=True).mean().iloc[7:-7]
    return test.target_date.dt.strftime("%m-%d").map(s).to_numpy()


# ───────────── metrics ─────────────
def _pinball(y, q, a):
    d = y - q
    return np.mean(np.maximum(a * d, (a - 1) * d))


def _dm_test(e1: np.ndarray, e2: np.ndarray, h: int) -> float:
    """Diebold-Mariano p-value (two-sided) for |e1| vs |e2| with Newey-West variance."""
    d = np.abs(e1) - np.abs(e2)
    n = len(d)
    if n < 10:
        return float("nan")
    dbar = d.mean()
    gamma0 = np.var(d, ddof=0)
    s = gamma0 + 2 * sum((1 - k / h) * np.cov(d[k:], d[:-k], ddof=0)[0, 1] for k in range(1, h)) if h > 1 else gamma0
    stat = dbar / math.sqrt(max(s, 1e-9) / n)
    return float(2 * (1 - 0.5 * (1 + math.erf(abs(stat) / math.sqrt(2)))))


def metrics(bt: pd.DataFrame, threshold: float = 0.5) -> dict:
    res = {"by_horizon": [], "by_season": []}
    for h, g in bt.groupby("horizon_h"):
        res["by_horizon"].append(_block(g, threshold) | {"horizon_h": int(h)})
    for (y, h), g in bt[bt.horizon_h == 48].groupby(["season", "horizon_h"]):
        res["by_season"].append(_block(g, threshold) | {"season": int(y)})
    res["overall_48h"] = _block(bt[bt.horizon_h == 48], threshold) if (bt.horizon_h == 48).any() else {}
    return res


def _block(g: pd.DataFrame, th: float) -> dict:
    y = g.actual.to_numpy(float)
    mae = float(np.mean(np.abs(y - g.p50)))
    mae_p = float(np.mean(np.abs(y - g.persistence)))
    mae_c = float(np.nanmean(np.abs(y - g.climatology)))
    sev = y > C.SEVERE
    warn = g.p_severe.to_numpy() >= th
    hits, miss, fa = int((sev & warn).sum()), int((sev & ~warn).sum()), int((~sev & warn).sum())
    h = int(g.horizon_h.iloc[0]) // 24 if len(g) else 1
    return {
        "n": int(len(g)),
        "mae": round(mae, 1), "mae_persistence": round(mae_p, 1), "mae_climatology": round(mae_c, 1),
        "skill_vs_persistence": round(1 - mae / mae_p, 3) if mae_p else None,
        "skill_vs_climatology": round(1 - mae / mae_c, 3) if mae_c else None,
        "dm_pvalue_vs_persistence": round(_dm_test(y - g.p50.to_numpy(), y - g.persistence.to_numpy(), h), 4),
        "coverage_80": round(float(np.mean((y >= g.p10) & (y <= g.p90))), 3),
        "pinball": round(float(np.mean([_pinball(y, g[c].to_numpy(), a) for c, a in (("p10", .1), ("p50", .5), ("p90", .9))])), 2),
        "severe_days": int(sev.sum()), "hits": hits, "misses": miss, "false_alarms": fa,
        "hit_rate": round(hits / (hits + miss), 3) if hits + miss else None,
        "false_alarm_ratio": round(fa / (hits + fa), 3) if hits + fa else None,
        "csi": round(hits / (hits + miss + fa), 3) if hits + miss + fa else None,
        "brier_severe": round(float(np.mean((g.p_severe.to_numpy() - sev) ** 2)), 4),
        "band_accuracy": round(float(np.mean(_band(g.p50.to_numpy()) == _band(y))), 3),
    }


def _band(a: np.ndarray) -> np.ndarray:
    return np.digitize(a, [50, 100, 200, 300, 400])


def calibration(bt: pd.DataFrame, bins: int = 5) -> list[dict]:
    g = bt[bt.horizon_h == 48].copy()
    if not len(g):
        return []
    g["bin"] = np.minimum((g.p_severe * bins).astype(int), bins - 1)
    out = []
    for b, x in g.groupby("bin"):
        out.append({"bin": f"{b / bins:.1f}–{(b + 1) / bins:.1f}", "predicted": round(float(x.p_severe.mean()), 3),
                    "observed": round(float((x.actual > C.SEVERE).mean()), 3), "n": int(len(x))})
    return out


# ───────────── live ─────────────
LIVE: dict = {}  # horizon → (models, feature row) from the last live run, reused by the what-if grid


def live_forecast(feats: pd.DataFrame) -> tuple[pd.DataFrame, dict, dict]:
    """Train on all history per horizon, forecast from the latest issue day."""
    latest = feats.issue_date.max()
    rows, expl, imps = [], {}, {}
    for h in sorted(feats.horizon_h.unique()):
        fh = feats[feats.horizon_h == h]
        models = fit(fh)
        x = fh[fh.issue_date == latest]
        if not len(x):
            continue
        p = predict(models, x)
        LIVE[int(h)] = (models, x)
        rows.append(pd.concat([x[["issue_date", "target_date", "horizon_h", "aqi_0"]], p], axis=1))
        expl[int(h)] = explain_row(models, x)
        imps[int(h)] = importance(models)
        for q, m in models.items():
            if q == "_adj":
                continue
            m.booster_.save_model((MODEL_DIR / f"h{int(h)}_q{int(q * 100)}.txt").as_posix())
    return pd.concat(rows, ignore_index=True), expl, imps


def save_json(obj, name: str):
    (C.DATA / name).write_text(json.dumps(obj, indent=2, default=str))
