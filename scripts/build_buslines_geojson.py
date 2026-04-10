"""Convert GTFS routes + trips + shapes into a single GeoJSON with one LineString per route."""

import csv
import json
import os
import re
from collections import defaultdict

BASE = os.path.join(os.path.dirname(__file__), "..", "buslinien")
OUT = os.path.join(os.path.dirname(__file__), "..", "app", "public", "pois", "buslinien.geojson")

# 1. Parse routes (skip E… and N… lines)
routes = {}
with open(os.path.join(BASE, "routes.txt"), encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        name = row["route_short_name"]
        if re.match(r'^[EN]', name, re.IGNORECASE):
            continue
        routes[row["route_id"]] = {
            "name": name,
            "color": "#" + row["route_color"] if row["route_color"] else "#888888",
        }

# 2. Parse trips → collect shape_ids per route
route_shapes = defaultdict(set)
with open(os.path.join(BASE, "trips.txt"), encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        sid = row.get("shape_id", "").strip()
        if sid:
            route_shapes[row["route_id"]].add(sid)

# 3. Parse shapes → build coordinate lists per shape_id
shapes = defaultdict(list)
with open(os.path.join(BASE, "shapes.txt"), encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        shapes[row["shape_id"]].append(
            (int(row["shape_pt_sequence"]), float(row["shape_pt_lon"]), float(row["shape_pt_lat"]))
        )

# Sort each shape by sequence
for sid in shapes:
    shapes[sid].sort(key=lambda t: t[0])

# 4. For each route pick the longest shape (most points)
features = []
for route_id, info in sorted(routes.items(), key=lambda x: x[1]["name"]):
    shape_ids = route_shapes.get(route_id, set())
    if not shape_ids:
        continue

    best_sid = max(shape_ids, key=lambda sid: len(shapes.get(sid, [])))
    pts = shapes.get(best_sid, [])
    if len(pts) < 2:
        continue

    coords = [[lon, lat] for _, lon, lat in pts]

    # Compute midpoint for label placement
    mid_idx = len(coords) // 2
    mid_coord = coords[mid_idx]

    features.append({
        "type": "Feature",
        "properties": {
            "route_id": route_id,
            "name": info["name"],
            "color": info["color"],
            "label_lon": mid_coord[0],
            "label_lat": mid_coord[1],
        },
        "geometry": {
            "type": "LineString",
            "coordinates": coords,
        },
    })

def sort_key(name):
    m = re.match(r'^(\d+)', name)
    return int(m.group(1)) if m else float('inf')

features.sort(key=lambda f: sort_key(f["properties"]["name"]))

geojson = {"type": "FeatureCollection", "features": features}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(geojson, f)

print(f"Wrote {len(features)} bus routes to {OUT}")
