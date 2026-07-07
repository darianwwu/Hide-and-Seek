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
import math
import os
import random
import time
import urllib.request
from collections import OrderedDict

random.seed(1)  # deterministic "random" name pick when merging
MERGE_RADIUS_M = 70

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
    ("museen", [("tourism", "museum")]),
    ("buechereien", [("amenity", "library")]),
    ("friedhoefe", [("landuse", "cemetery"), ("amenity", "grave_yard")]),
    ("baeder", [("leisure", "swimming_pool"), ("amenity", "public_bath"), ("leisure", "water_park")]),
    ("sportstaetten", [("leisure", "sports_centre"), ("leisure", "stadium"), ("leisure", "sports_hall")]),
    ("tankstellen", [("amenity", "fuel")]),
    ("apotheken", [("amenity", "pharmacy")]),
])

EXCLUDED_NAMES: dict[str, set[str]] = {
    "tankstellen": {
        "Esso 3",
        "Flüssiggas GmbH Drei Gleicheausen",
        "Oil",
        "Total 3",
        "Total 4",
    },
}


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


def haversine_m(a, b):
    R = 6371000.0
    (lat1, lon1), (lat2, lon2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.asin(math.sqrt(x))


def merge_features(features: list, radius_m: float) -> list:
    """Merge same-category POIs within radius_m into one feature (centroid +
    a random name from the cluster) via single-linkage union-find."""
    n = len(features)
    pts = [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in features]  # (lat, lon)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if haversine_m(pts[i], pts[j]) <= radius_m:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj

    clusters: dict = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)

    out = []
    for members in clusters.values():
        names = [features[m]["properties"]["NAME"] for m in members]
        lats = [pts[m][0] for m in members]
        lons = [pts[m][1] for m in members]
        out.append({
            "type": "Feature",
            "properties": {"NAME": random.choice(names)},
            "geometry": {
                "type": "Point",
                "coordinates": [round(sum(lons) / len(lons), 6), round(sum(lats) / len(lats), 6)],
            },
        })
    out.sort(key=lambda f: f["properties"]["NAME"].lower())
    return out


def number_duplicates(features: list) -> list:
    """Make NAME unique within a layer: same-named POIs get a trailing
    counter ("Aral" -> "Aral 1", "Aral 2", ...) so each POI is editable."""
    from collections import Counter
    totals = Counter(f["properties"]["NAME"] for f in features)
    seen: dict = {}
    for f in features:
        name = f["properties"]["NAME"]
        if totals[name] > 1:
            seen[name] = seen.get(name, 0) + 1
            f["properties"]["NAME"] = f"{name} {seen[name]}"
    return features


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for layer_id, selectors in CATEGORIES.items():
        data = fetch(build_query(selectors))
        features = [f for f in to_features(data) if keep_feature(layer_id, f["properties"]["NAME"])]
        raw = len(features)
        features = merge_features(features, MERGE_RADIUS_M)
        features = number_duplicates(features)
        merged = len(features)
        excluded = EXCLUDED_NAMES.get(layer_id, set())
        if excluded:
            features = [f for f in features if f["properties"]["NAME"] not in excluded]
        out = os.path.join(OUT_DIR, f"{layer_id}.geojson")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": features}, fh, ensure_ascii=False)
        removed = merged - len(features)
        suffix = f", {removed} excluded" if removed else ""
        print(f"{layer_id}: {raw} named -> {len(features)} after {int(MERGE_RADIUS_M)}m merge{suffix}")
        time.sleep(2)  # be polite to the public Overpass instance


if __name__ == "__main__":
    main()
