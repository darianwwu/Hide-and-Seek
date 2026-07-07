"""
Build the Erfurt datasets for the Hide-and-Seek app from open data:

  * Stops  -> app/src/data/stops.erfurt.ts
      All tram stops (lines 1-6) + selected bus lines, taken from the VMT GTFS
      feed (EVAG, agency_id 119), grouped by name.
  * Lines  -> app/public/erfurt/pois/buslinien.geojson
      One LineString per line, reconstructed from the stop sequence of the
      longest trip (the VMT feed ships an empty shapes.txt).
  * Districts -> app/public/erfurt/stadtteile.geojson
      Erfurt Ortsteile from the Geoportal, filtered to covered hideouts and
      merged into coarse, roughly balanced Ortsteil groups.

Sources:
  VMT GTFS         https://www.vmt-thueringen.de/service/open-data/   (CC BY)
  Geoportal Erfurt https://geoportal.erfurt.de/.../stadtteile.zip      (DL-DE-BY-2.0)

Run from the repo root:  python scripts/build_erfurt_data.py
Downloads are cached in $ERFURT_CACHE (default: a temp dir) to avoid re-fetching.
"""

import csv
import io
import json
import os
import tempfile
import urllib.request
import zipfile
from collections import defaultdict

GTFS_URL = "https://www.vmt-thueringen.de/fileadmin/VMT_Redaktion/OPEN_DATA/VMT_GTFS.zip"
STADTTEILE_URL = "https://geoportal.erfurt.de/gis/pub/download/thematik/stadtteile.zip"

EVAG_AGENCY = "119"
TRAM_LINES = {"1", "2", "3", "4", "5", "6"}
# Core city lines + the lines that reach every otherwise-uncovered Ortsteil
# (43/92/60/75/31/91/20/52 give full 53/53 Ortsteil coverage).
BUS_LINES = {"9", "10", "30", "51", "80", "90", "43", "92", "60", "75", "31", "91", "20", "52"}
TARGET_LINES = TRAM_LINES | BUS_LINES

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_STOPS = os.path.join(REPO, "app", "src", "data", "stops.erfurt.ts")
OUT_PUBLIC = os.path.join(REPO, "app", "public", "erfurt")
OUT_POIS = os.path.join(OUT_PUBLIC, "pois")
OUT_BUSLINES = os.path.join(OUT_POIS, "buslinien.geojson")
OUT_STADTTEILE = os.path.join(OUT_PUBLIC, "stadtteile.geojson")

CACHE = os.environ.get("ERFURT_CACHE", os.path.join(tempfile.gettempdir(), "erfurt_gtfs_cache"))

# Coarse Ortsteil groups used by the app. Small neighboring Ortsteile are
# relabeled to the largest Ortsteil in their contiguous group.
ORTSTEIL_GROUPS: dict[str, str] = {
    "Löbervorstadt": "Löbervorstadt",
    "Möbisburg-Rhoda": "Löbervorstadt",
    "Bischleben-Stedten": "Löbervorstadt",
    "Brühlervorstadt": "Brühlervorstadt",
    "Rieth": "Gispersleben",
    "Gispersleben": "Gispersleben",
    "Berliner Platz": "Gispersleben",
    "Moskauer Platz": "Gispersleben",
    "Altstadt": "Altstadt",
    "Niedernissa": "Melchendorf",
    "Herrenberg": "Melchendorf",
    "Wiesenhügel": "Melchendorf",
    "Melchendorf": "Melchendorf",
    "Windischholzhausen": "Melchendorf",
    "Urbich": "Melchendorf",
    "Dittelstedt": "Melchendorf",
    "Daberstedt": "Daberstedt",
    "Linderbach": "Krämpfervorstadt",
    "Krämpfervorstadt": "Krämpfervorstadt",
    "Marbach": "Andreasvorstadt",
    "Andreasvorstadt": "Andreasvorstadt",
    "Azmannsdorf": "Büßleben",
    "Hochstedt": "Büßleben",
    "Töttleben": "Büßleben",
    "Büßleben": "Büßleben",
    "Kerspleben": "Büßleben",
    "Schmira": "Bindersleben",
    "Bindersleben": "Bindersleben",
    "Hochheim": "Bindersleben",
    "Johannesplatz": "Ilversgehofen",
    "Johannesvorstadt": "Ilversgehofen",
    "Ilversgehofen": "Ilversgehofen",
    "Roter Berg": "Roter Berg",
    "Sulzer Siedlung": "Roter Berg",
    "Hohenwinden": "Roter Berg",
}

# Stops curated out via the in-app Haltestellen-Editor (rectangle tool).
EXCLUDE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "erfurt_excluded_stops.json")
EXCLUDE_IDS: set = set()
if os.path.exists(EXCLUDE_FILE):
    with open(EXCLUDE_FILE, encoding="utf-8") as _f:
        EXCLUDE_IDS = {str(s).strip().lower() for s in json.load(_f)}


def cached(url: str, name: str) -> str:
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print(f"Downloading {url} ...")
        urllib.request.urlretrieve(url, path)
    return path


def reader(zf: zipfile.ZipFile, name: str):
    return csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="utf-8-sig"))


def clean_name(raw: str) -> str:
    name = (raw or "").strip()
    if name.startswith("Erfurt, "):
        name = name[len("Erfurt, "):]
    return name


def main() -> None:
    gtfs_path = cached(GTFS_URL, "vmt_gtfs.zip")
    stadtteile_path = cached(STADTTEILE_URL, "stadtteile.zip")
    zf = zipfile.ZipFile(gtfs_path)

    # 1. Target routes: EVAG only, by line number. Group route_ids per line.
    line_of_route: dict[str, str] = {}
    line_is_tram: dict[str, bool] = {}
    line_color: dict[str, str] = {}
    for r in reader(zf, "routes.txt"):
        if r.get("agency_id") != EVAG_AGENCY:
            continue
        sn = (r.get("route_short_name") or "").strip()
        if sn not in TARGET_LINES:
            continue
        rid = r["route_id"]
        line_of_route[rid] = sn
        is_tram = (r.get("route_type") == "0") or sn in TRAM_LINES
        line_is_tram[sn] = line_is_tram.get(sn, False) or is_tram
        color = (r.get("route_color") or "").strip()
        if color and not line_color.get(sn):
            line_color[sn] = color
    print(f"Target EVAG routes: {len(line_of_route)} route_ids across {len(set(line_of_route.values()))} lines")

    # 2. Trips of the target routes -> trip_id -> line.
    trip_line: dict[str, str] = {}
    for t in reader(zf, "trips.txt"):
        rid = t.get("route_id")
        if rid in line_of_route:
            trip_line[t["trip_id"]] = line_of_route[rid]
    print(f"Target trips: {len(trip_line)}")

    # 3. Stream stop_times: per-line stop set + per-trip ordered stop sequence.
    line_stops: dict[str, set] = defaultdict(set)
    trip_seq: dict[str, list] = defaultdict(list)  # trip_id -> [(seq, stop_id)]
    with zf.open("stop_times.txt") as f:
        rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        for row in rd:
            tid = row["trip_id"]
            line = trip_line.get(tid)
            if line is None:
                continue
            sid = row["stop_id"]
            line_stops[line].add(sid)
            try:
                seq = int(row["stop_sequence"])
            except (TypeError, ValueError):
                seq = len(trip_seq[tid])
            trip_seq[tid].append((seq, sid))
    print("Stop sets per line:", {ln: len(s) for ln, s in sorted(line_stops.items())})

    # 4. Stops master table.
    stop_info: dict[str, dict] = {}
    for s in reader(zf, "stops.txt"):
        try:
            lat = float(s["stop_lat"])
            lon = float(s["stop_lon"])
        except (TypeError, ValueError):
            continue
        stop_info[s["stop_id"]] = {"name": clean_name(s.get("stop_name", "")), "lat": lat, "lon": lon}

    # 5. Hideouts: union of all selected stops, grouped by display name.
    selected = set().union(*line_stops.values()) if line_stops else set()
    groups: dict[str, dict] = {}
    for sid in selected:
        info = stop_info.get(sid)
        if not info or not info["name"]:
            continue
        key = info["name"].lower()
        g = groups.setdefault(key, {"id": key, "name": info["name"], "latSum": 0.0, "lonSum": 0.0, "count": 0})
        g["latSum"] += info["lat"]
        g["lonSum"] += info["lon"]
        g["count"] += 1
    hideouts = [
        {
            "id": g["id"],
            "name": g["name"],
            "lat": round(g["latSum"] / g["count"], 6),
            "lon": round(g["lonSum"] / g["count"], 6),
            "count": g["count"],
        }
        for g in groups.values()
    ]
    hideouts.sort(key=lambda s: s["name"].lower())
    present = {h["id"] for h in hideouts}
    matched = EXCLUDE_IDS & present
    missing = sorted(EXCLUDE_IDS - present)
    hideouts = [h for h in hideouts if h["id"] not in EXCLUDE_IDS]
    visible_stop_keys = {h["id"] for h in hideouts}
    print(f"Excluded {len(matched)}/{len(EXCLUDE_IDS)} editor stops; {len(hideouts)} hideouts remain")
    if missing:
        print(f"  WARNING: {len(missing)} exclude id(s) not found in current stops:", missing)

    os.makedirs(os.path.dirname(OUT_STOPS), exist_ok=True)
    ts = (
        'import type { Stop } from "./stops";\n\n'
        "// Generated by scripts/build_erfurt_data.py from the VMT GTFS feed.\n"
        "// All tram stops (lines 1-6) + selected EVAG bus lines.\n"
        "export const STOPS: Stop[] = "
        + json.dumps(hideouts, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    with open(OUT_STOPS, "w", encoding="utf-8") as fh:
        fh.write(ts)
    print(f"Wrote {OUT_STOPS}")

    # 6. Line geometry: longest trip per line, trimmed to the first/last
    # retained hideout stop so removed outer stops do not leave dangling tails.
    features = []
    lines = sorted(set(line_of_route.values()), key=lambda ln: (0 if line_is_tram.get(ln) else 1, int(ln)))
    for line in lines:
        best_trip, best_len = None, -1
        for tid, line2 in trip_line.items():
            if line2 == line and len(trip_seq.get(tid, [])) > best_len:
                best_trip, best_len = tid, len(trip_seq[tid])
        if best_trip is None:
            continue
        ordered_stops = sorted(trip_seq[best_trip], key=lambda x: x[0])
        visible_indices = [
            idx
            for idx, (_seq, sid) in enumerate(ordered_stops)
            if stop_info.get(sid, {}).get("name", "").lower() in visible_stop_keys
        ]
        if len(visible_indices) < 2:
            continue
        start_idx, end_idx = visible_indices[0], visible_indices[-1]
        coords = []
        for _seq, sid in ordered_stops[start_idx:end_idx + 1]:
            info = stop_info.get(sid)
            if not info:
                continue
            pt = [round(info["lon"], 6), round(info["lat"], 6)]
            if not coords or coords[-1] != pt:
                coords.append(pt)
        if len(coords) < 2:
            continue
        mid = coords[len(coords) // 2]
        color = line_color.get(line, "")
        features.append({
            "type": "Feature",
            "properties": {
                "route_id": f"evag-{line}",
                "name": line,
                "color": "#" + color if color else ("#888888"),
                "label_lon": mid[0],
                "label_lat": mid[1],
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    os.makedirs(OUT_POIS, exist_ok=True)
    with open(OUT_BUSLINES, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, ensure_ascii=False)
    print(f"Wrote {OUT_BUSLINES} ({len(features)} lines)")

    # 7. Stadtteile: keep covered Ortsteile and relabel small neighbors into
    # coarse, contiguous groups.
    zs = zipfile.ZipFile(stadtteile_path)
    jsonname = next(n for n in zs.namelist() if n.lower().endswith(".json"))
    stadtteile = json.loads(zs.read(jsonname).decode("utf-8"))

    def point_in_ring(lon, lat, ring):
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
                inside = not inside
            j = i
        return inside

    def feature_contains(lon, lat, geom):
        rings = [geom["coordinates"][0]] if geom["type"] == "Polygon" else [poly[0] for poly in geom["coordinates"]]
        return any(point_in_ring(lon, lat, r) for r in rings)

    kept, removed = [], []
    for ft in stadtteile["features"]:
        if any(feature_contains(h["lon"], h["lat"], ft["geometry"]) for h in hideouts):
            name = str(ft["properties"].get("NAME") or "")
            ft["properties"]["NAME"] = ORTSTEIL_GROUPS.get(name, name)
            kept.append(ft)
        else:
            removed.append(ft["properties"].get("NAME"))
    stadtteile["features"] = kept
    with open(OUT_STADTTEILE, "w", encoding="utf-8") as fh:
        json.dump(stadtteile, fh, ensure_ascii=False)
    groups = sorted({str(ft["properties"].get("NAME") or "") for ft in kept})
    print(f"Wrote {OUT_STADTTEILE} ({len(kept)} Ortsteil polygons, {len(groups)} coarse groups, {len(removed)} removed)")
    if removed:
        print("  removed Ortsteile:", sorted(removed))


if __name__ == "__main__":
    main()
