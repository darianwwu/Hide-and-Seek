"""
Re-add removed bus stops that lie within 150 m of an existing bus line.
Run from the repo root:  python scripts/restore_busline_stops.py
"""

import json
import math
import re
import urllib.request
from pathlib import Path

# ---------- config ----------
TOLERANCE_M = 150
BUSLINES_PATH = Path("app/public/pois/buslinien.geojson")
STOPS_TS_PATH = Path("app/src/data/stops.ts")

# ---------- Overpass query (same as generate_hardcoded_stops.py) ----------
# Bounding box for Münster (faster than area query)
QUERY = """[out:json][timeout:30];
node["highway"="bus_stop"](51.85,7.47,52.06,7.78);
out body;"""


# ---------- haversine distance in metres ----------
def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def point_to_segment_distance(plat: float, plon: float,
                               alat: float, alon: float,
                               blat: float, blon: float) -> float:
    """Approximate min distance from point to line segment (a->b) in metres."""
    dx = blon - alon
    dy = blat - alat
    if dx == 0 and dy == 0:
        return haversine(plat, plon, alat, alon)
    t = max(0, min(1, ((plon - alon) * dx + (plat - alat) * dy) / (dx * dx + dy * dy)))
    proj_lat = alat + t * dy
    proj_lon = alon + t * dx
    return haversine(plat, plon, proj_lat, proj_lon)


def min_distance_to_line(lat: float, lon: float, coords: list[list[float]]) -> float:
    """Min distance from (lat, lon) to a polyline given as [[lon, lat], ...]."""
    best = float("inf")
    for i in range(len(coords) - 1):
        d = point_to_segment_distance(
            lat, lon,
            coords[i][1], coords[i][0],
            coords[i + 1][1], coords[i + 1][0],
        )
        if d < best:
            best = d
            if best < 1:
                return best
    return best


def main() -> None:
    # 1. Load current stops
    ts_source = STOPS_TS_PATH.read_text(encoding="utf-8")
    m = re.search(r"export const STOPS:\s*Stop\[\]\s*=\s*(\[.*\]);", ts_source, re.S)
    if not m:
        raise RuntimeError("Cannot parse stops.ts")
    current_stops: list[dict] = json.loads(m.group(1))
    existing_ids = {s["id"] for s in current_stops}
    print(f"Current stops: {len(current_stops)}")

    # 2. Fetch ALL bus stops from Overpass
    print("Fetching all bus stops from Overpass API ...")
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=QUERY.encode("utf-8"),
        method="POST",
    )
    raw = urllib.request.urlopen(req).read()
    data = json.loads(raw)

    groups: dict[str, dict] = {}
    for stop in data.get("elements", []):
        if "lat" not in stop or "lon" not in stop:
            continue
        name = ((stop.get("tags") or {}).get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in groups:
            groups[key]["latSum"] += stop["lat"]
            groups[key]["lonSum"] += stop["lon"]
            groups[key]["count"] += 1
        else:
            groups[key] = {
                "id": key,
                "name": name,
                "latSum": stop["lat"],
                "lonSum": stop["lon"],
                "count": 1,
            }

    all_stops = []
    for g in groups.values():
        all_stops.append({
            "id": g["id"],
            "name": g["name"],
            "lat": round(g["latSum"] / g["count"], 6),
            "lon": round(g["lonSum"] / g["count"], 6),
            "count": g["count"],
        })
    print(f"All Overpass stops (grouped): {len(all_stops)}")

    # 3. Find candidates: stops NOT already in the app
    candidates = [s for s in all_stops if s["id"] not in existing_ids]
    print(f"Candidates (not yet in app): {len(candidates)}")

    # 4. Load bus lines
    buslines = json.loads(BUSLINES_PATH.read_text(encoding="utf-8"))
    lines = [f["geometry"]["coordinates"] for f in buslines["features"]]
    print(f"Bus lines loaded: {len(lines)}")

    # 5. Check each candidate against all bus lines
    to_add = []
    for s in candidates:
        for coords in lines:
            d = min_distance_to_line(s["lat"], s["lon"], coords)
            if d <= TOLERANCE_M:
                to_add.append(s)
                break

    print(f"Stops to re-add (within {TOLERANCE_M} m of a bus line): {len(to_add)}")
    for s in sorted(to_add, key=lambda x: x["name"].lower()):
        print(f"  + {s['name']} ({s['lat']}, {s['lon']})")

    # 6. Merge and write updated stops.ts
    merged = current_stops + to_add
    merged.sort(key=lambda s: s["name"].lower())
    print(f"\nTotal stops after merge: {len(merged)}")

    ts_out = (
        'export type Stop = { id: string; name: string; lat: number; lon: number; count: number };\n\n'
        'export const STOPS: Stop[] = '
        + json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    STOPS_TS_PATH.write_text(ts_out, encoding="utf-8")
    print(f"Written to {STOPS_TS_PATH}")


if __name__ == "__main__":
    main()
