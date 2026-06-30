"""
Build the Erfurt POI layers for the Hide-and-Seek app from OpenStreetMap via
the Overpass API, into app/public/erfurt/pois/<id>.geojson.

Each output is a GeoJSON FeatureCollection of named Point features with a
"NAME" property (the layer config in cities.ts uses nameKey "NAME"). Ways and
relations are reduced to their centroid (Overpass `out center`). Only named
features are kept, so they are usable for the MATCH_POI question.

Run from the repo root:  python scripts/build_erfurt_pois.py
"""

import json
import os
import time
import urllib.request
from collections import OrderedDict

# Erfurt bounding box (S, W, N, E)
BBOX = "50.890,10.855,51.080,11.175"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "app", "public", "erfurt", "pois")

# layer id -> list of (key, value) tag selectors
CATEGORIES: "OrderedDict[str, list]" = OrderedDict([
    ("kitas", [("amenity", "kindergarten")]),
    ("schulen", [("amenity", "school")]),
    ("krankenhaeuser", [("amenity", "hospital")]),
    ("museen", [("tourism", "museum")]),
    ("buechereien", [("amenity", "library")]),
    ("friedhoefe", [("landuse", "cemetery"), ("amenity", "grave_yard")]),
    ("baeder", [("leisure", "swimming_pool"), ("amenity", "public_bath"), ("leisure", "water_park")]),
    ("sportstaetten", [("leisure", "sports_centre"), ("leisure", "stadium"), ("leisure", "sports_hall")]),
])


def build_query(selectors: list) -> str:
    parts = []
    for key, value in selectors:
        for kind in ("node", "way", "relation"):
            parts.append(f'  {kind}["{key}"="{value}"]({BBOX});')
    body = "\n".join(parts)
    return f"[out:json][timeout:90];\n(\n{body}\n);\nout center tags;"


def fetch(query: str) -> dict:
    """POST the query, rotating endpoints and backing off on 429/5xx/timeouts."""
    last_err = None
    for attempt in range(6):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        req = urllib.request.Request(
            endpoint,
            data=query.encode("utf-8"),
            method="POST",
            headers={"User-Agent": "hide-and-seek-erfurt-builder/1.0 (contact: github hide-and-seek)"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as err:  # noqa: BLE001 - retry on any transport error
            last_err = err
            wait = 10 * (attempt + 1)
            print(f"  {endpoint} failed ({err}); retrying in {wait}s ...")
            time.sleep(wait)
    raise RuntimeError(f"Overpass failed after retries: {last_err}")


# landuse=cemetery in OSM also covers grave-fields inside a big cemetery
# ("Grabfeld 12", "Ehrenhain …"). Keep only real cemeteries by name.
CEMETERY_WORDS = ("friedhof", "kirchhof", "gottesacker", "cemetery")


def keep_feature(layer_id: str, name: str) -> bool:
    if layer_id == "friedhoefe":
        return any(w in name.lower() for w in CEMETERY_WORDS)
    return True


def to_features(data: dict) -> list:
    seen = set()
    features = []
    for el in data.get("elements", []):
        key = (el.get("type"), el.get("id"))
        if key in seen:
            continue
        name = (el.get("tags") or {}).get("name")
        if not name:
            continue
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            center = el.get("center") or {}
            lat, lon = center.get("lat"), center.get("lon")
        if lat is None or lon is None:
            continue
        seen.add(key)
        features.append({
            "type": "Feature",
            "properties": {"NAME": name},
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    features.sort(key=lambda f: f["properties"]["NAME"].lower())
    return features


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for layer_id, selectors in CATEGORIES.items():
        data = fetch(build_query(selectors))
        features = [f for f in to_features(data) if keep_feature(layer_id, f["properties"]["NAME"])]
        out = os.path.join(OUT_DIR, f"{layer_id}.geojson")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": features}, fh, ensure_ascii=False)
        print(f"{layer_id}: {len(features)} named features -> {out}")
        time.sleep(2)  # be polite to the public Overpass instance


if __name__ == "__main__":
    main()
