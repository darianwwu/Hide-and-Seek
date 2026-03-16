import json
import urllib.request


QUERY = """[out:json][timeout:60];
area["name"="Münster"]["admin_level"="6"]->.muenster;
(
  node["highway"="bus_stop"](area.muenster);
);
out body;"""


def main() -> None:
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

    stops = []
    for g in groups.values():
        stops.append(
            {
                "id": g["id"],
                "name": g["name"],
                "lat": round(g["latSum"] / g["count"], 6),
                "lon": round(g["lonSum"] / g["count"], 6),
                "count": g["count"],
            }
        )

    stops.sort(key=lambda item: item["name"].lower())

    content = "const HARDCODED_STOPS = " + json.dumps(
        stops, ensure_ascii=False, separators=(",", ":")
    ) + ";\n"

    with open("busstops-hardcoded.js", "w", encoding="utf-8") as f:
        f.write(content)

    print(f"hardcoded stops: {len(stops)}")


if __name__ == "__main__":
    main()
