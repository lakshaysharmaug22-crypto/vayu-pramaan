"""Download the CPCB Delhi station CSVs published on OpenCity (public domain) into data/raw/aqi_opencity/.

Uses the portal's CKAN API to list the dataset's files; falls back to reading the dataset page.
"""
import re
import sys
import time
from pathlib import Path

import requests

DATASET = "delhi-hourly-air-quality-reports"
BASE = "https://data.opencity.in"
OUT = Path("data/raw/aqi_opencity")
S = requests.Session()
S.headers["User-Agent"] = "vayu-pramaan/1.0 (open air-quality research project)"


def resources() -> list[tuple[str, str]]:
    try:
        r = S.get(f"{BASE}/api/3/action/package_show", params={"id": DATASET}, timeout=60)
        r.raise_for_status()
        res = r.json()["result"]["resources"]
        return [(x["url"], x.get("name") or x["url"].rsplit("/", 1)[-1]) for x in res
                if (x.get("format") or "").lower() == "csv" or x["url"].lower().endswith(".csv")]
    except Exception as e:  # API unavailable: read links off the dataset page
        print(f"CKAN API failed ({e}); scraping the dataset page", file=sys.stderr)
        html = S.get(f"{BASE}/dataset/{DATASET}", timeout=60).text
        links = sorted(set(re.findall(r'href="([^"]+/download/[^"]+\.csv)"', html)))
        return [(l if l.startswith("http") else BASE + l, l.rsplit("/", 1)[-1]) for l in links]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    items = resources()
    print(f"{len(items)} CSV files listed")
    ok = 0
    for url, name in items:
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        fn = OUT / f"{slug}.csv"
        if fn.exists() and fn.stat().st_size > 1000:
            ok += 1; continue
        for i in range(3):
            try:
                r = S.get(url, timeout=180)
                r.raise_for_status()
                fn.write_bytes(r.content)
                ok += 1
                print(f"  {fn.name}  {len(r.content) // 1024} KB")
                break
            except Exception as e:
                print(f"  retry {i + 1} {fn.name}: {e}", file=sys.stderr)
                time.sleep(3 * (i + 1))
    print(f"downloaded {ok}/{len(items)}")
    if ok == 0:
        sys.exit("no station files downloaded")


if __name__ == "__main__":
    main()
