"""State assignment for fire points.

Uses real state boundaries when data/ref/india_states.geojson exists (any India state
GeoJSON with a state-name property works). Otherwise falls back to a documented
bounding-box split, which is approximate near the Punjab–Haryana border.
"""
from __future__ import annotations

import json
from functools import lru_cache

import numpy as np

from . import config as C

GEOJSON = C.DATA / "ref" / "india_states.geojson"
WANTED = {"punjab": "Punjab", "haryana": "Haryana"}
NAME_KEYS = ("ST_NM", "st_nm", "NAME_1", "state", "State", "name", "NAME")


@lru_cache(maxsize=1)
def _polygons() -> dict[str, list[np.ndarray]] | None:
    if not GEOJSON.exists():
        return None
    gj = json.loads(GEOJSON.read_text())
    polys: dict[str, list[np.ndarray]] = {}
    for feat in gj.get("features", []):
        props = feat.get("properties", {})
        name = next((str(props[k]) for k in NAME_KEYS if k in props), "").strip().lower()
        if name not in WANTED:
            continue
        geom = feat["geometry"]
        rings = geom["coordinates"] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]
        if geom["type"] == "Polygon":
            rings = [rings[0]]
        polys.setdefault(WANTED[name], []).extend(np.asarray(r, dtype=float) for r in rings)
    return polys or None


def _inside(lon: np.ndarray, lat: np.ndarray, ring: np.ndarray) -> np.ndarray:
    x, y = ring[:, 0], ring[:, 1]
    inside = np.zeros(lon.shape, dtype=bool)
    j = len(ring) - 1
    for i in range(len(ring)):
        cond = ((y[i] > lat) != (y[j] > lat)) & \
               (lon < (x[j] - x[i]) * (lat - y[i]) / (y[j] - y[i] + 1e-12) + x[i])
        inside ^= cond
        j = i
    return inside


def assign_state(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    out = np.full(lat.shape, "Other", dtype=object)
    polys = _polygons()
    if polys:
        for state, rings in polys.items():
            m = np.zeros(lat.shape, dtype=bool)
            for r in rings:
                m |= _inside(lon, lat, r)
            out[m & (out == "Other")] = state
        return out
    pb, fb = C.PUNJAB_BBOX, C.FIRE_BBOX
    in_fire = (lat >= fb["south"]) & (lat <= fb["north"]) & (lon >= fb["west"]) & (lon <= fb["east"])
    in_pb = (lat >= pb["south"]) & (lat <= pb["north"]) & (lon >= pb["west"]) & (lon <= pb["east"])
    out[in_fire & in_pb] = "Punjab"
    out[in_fire & ~in_pb] = "Haryana"
    return out


def boundary_mode() -> str:
    return "state polygons" if _polygons() else "approximate bounding boxes"
