import json
import math
import re
from pathlib import Path


EARTH_METERS_PER_DEGREE = 111320.0
MOVE_METERS_EAST = 20.0


def main() -> None:
    file_path = Path("busstops-hardcoded.js")
    source = file_path.read_text(encoding="utf-8")
    match = re.match(r"^const HARDCODED_STOPS = (.*);\s*$", source, re.S)
    if not match:
        raise RuntimeError("Unexpected format in busstops-hardcoded.js")

    stops = json.loads(match.group(1))

    target = None
    for stop in stops:
        if (stop.get("id") or "").lower() == "kriegerweg":
            target = stop
            break

    if target is None:
        raise RuntimeError("Stop 'Kriegerweg' not found")

    old_lat = float(target["lat"])
    old_lon = float(target["lon"])

    meters_per_degree_lon = EARTH_METERS_PER_DEGREE * math.cos(math.radians(old_lat))
    delta_lon = MOVE_METERS_EAST / meters_per_degree_lon
    new_lon = old_lon + delta_lon

    target["lon"] = round(new_lon, 6)

    stops.sort(key=lambda item: (item.get("name") or "").lower())
    out = "const HARDCODED_STOPS = " + json.dumps(
        stops, ensure_ascii=False, separators=(",", ":")
    ) + ";\n"
    file_path.write_text(out, encoding="utf-8")

    print(f"Kriegerweg old: lat={old_lat}, lon={old_lon}")
    print(f"Kriegerweg new: lat={target['lat']}, lon={target['lon']}")


if __name__ == "__main__":
    main()
