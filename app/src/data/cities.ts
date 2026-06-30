import { STOPS as MUENSTER_STOPS } from "./stops";
import { STOPS as ERFURT_STOPS } from "./stops.erfurt";
import type { Stop } from "./stops";

// ── Shared geo/data types (consumed by App.tsx) ───────────────

export type Position = { lat: number; lon: number };

export type PoiFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Point"; coordinates: [number, number] };
};

export type PoiCollection = {
  type: "FeatureCollection";
  features: PoiFeature[];
};

export type PoiLayerConfig = {
  id: string;
  label: string;
  file: string;
  color: string;
  nameKey: string;
};

export type BusLineFeature = {
  type: "Feature";
  properties: { route_id: string; name: string; color: string; label_lat: number; label_lon: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

export type BusLineCollection = {
  type: "FeatureCollection";
  features: BusLineFeature[];
};

export type StadtteilFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
};

export type StadtteileCollection = {
  type: "FeatureCollection";
  features: StadtteilFeature[];
};

/**
 * One administrative level used by the MATCH_DISTRICT and MEASURE-border
 * questions. Münster has two (Bezirk / Stadtbezirk); Erfurt has one (Ortsteil).
 * `resolve` extracts the district name a feature belongs to, from its raw
 * GeoJSON properties. `code` is the single letter used in the question-code
 * wire format (must stay stable per city — the e2e suite asserts B/S).
 */
export type DistrictLevelConfig = {
  id: string;
  label: string;
  borderLabel: string;
  code: string;
  resolve: (props: Record<string, unknown>) => string | null;
};

export type CityConfig = {
  id: string;
  label: string;
  center: Position;
  hideRadiusM: number;
  poiBasePath: string;
  stadtteileFile: string;
  busLinesFile: string;
  stops: Stop[];
  poiLayers: PoiLayerConfig[];
  districtLevels: DistrictLevelConfig[];
  placeholder: string;
};

// ── Münster ───────────────────────────────────────────────────

const MUENSTER_GROUP_MAP: Record<string, string> = {
  "11": "Mitte", "12": "Mitte", "13": "Mitte", "14": "Mitte", "15": "Mitte",
  "21": "Mitte", "22": "Mitte", "23": "Mitte", "24": "Mitte", "25": "Mitte",
  "26": "Mitte", "27": "Mitte", "28": "Mitte", "29": "Mitte",
  "31": "Mitte Süd", "32": "Mitte Süd", "33": "Mitte Süd", "43": "Mitte Süd",
  "46": "Mitte Nord", "47": "Mitte Nord",
  "44": "Mauritz", "45": "Mauritz", "71": "Mauritz",
  "34": "Berg Fidel", "91": "Berg Fidel",
  "62": "Kinderhaus-Ost", "63": "Kinderhaus-West",
  "95": "Hiltrup", "96": "Hiltrup", "97": "Hiltrup",
  "81": "Gremmendorf", "82": "Gremmendorf",
  "51": "Gievenbeck", "52": "Sentrup", "54": "Mecklenbeck", "56": "Albachten",
  "57": "Roxel", "58": "Nienberge", "61": "Coerde", "68": "Sprakel",
  "76": "Gelmer", "77": "Handorf", "86": "Angelmodde", "87": "Wolbeck",
  "98": "Amelsbüren",
};

const MUENSTER_STADTBEZIRK_MAP: Record<string, string> = {
  "1 Altstadt": "Mitte",
  "2 Innenstadtring": "Mitte",
  "3 Mitte-Süd": "Mitte",
  "4 Mitte-Nordost": "Mitte",
  "5 Münster-West": "West",
  "6 Münster-Nord": "Nord",
  "7 Münster-Ost": "Ost",
  "8 Münster-Südost": "Südost",
  "9 Münster-Hiltrup": "Hiltrup",
};

const MUENSTER_POI_LAYERS: PoiLayerConfig[] = [
  { id: "kitas", label: "Kita", file: "kitas_ms.geojson", color: "#fdd835", nameKey: "E_NAME" },
  { id: "schulen", label: "Schule", file: "schulen_ms.geojson", color: "#9c27b0", nameKey: "NAME" },
  { id: "sportstaetten", label: "Sportstätte", file: "sportstaetten.geojson", color: "#4caf50", nameKey: "Name" },
  { id: "friedhoefe", label: "Friedhof", file: "friedhoefe.geojson", color: "#607d8b", nameKey: "NAME" },
  { id: "kinos", label: "Kino", file: "kinos.geojson", color: "#ff9800", nameKey: "NAME" },
  { id: "krankenhaeuser", label: "Krankenhaus", file: "krankenhaeuser.geojson", color: "#009688", nameKey: "NAME" },
  { id: "museen", label: "Museum", file: "museen.geojson", color: "#3f51b5", nameKey: "NAME" },
  { id: "buechereien", label: "Bücherei", file: "buechereien.geojson", color: "#00bcd4", nameKey: "NAME" },
  { id: "baeder", label: "Bad", file: "baeder.geojson", color: "#2196f3", nameKey: "NAME" },
];

const muenster: CityConfig = {
  id: "muenster",
  label: "Münster",
  center: { lat: 51.9607, lon: 7.6261 },
  hideRadiusM: 400,
  poiBasePath: "pois/",
  stadtteileFile: "stadtteile-muenster.geojson",
  busLinesFile: "pois/buslinien.geojson",
  stops: MUENSTER_STOPS,
  poiLayers: MUENSTER_POI_LAYERS,
  districtLevels: [
    {
      id: "bezirk",
      label: "Bezirk",
      borderLabel: "Bezirksgrenze",
      code: "B",
      resolve: (p) =>
        MUENSTER_GROUP_MAP[String(p.NR_STATIST ?? "")] ?? (p.NAME_STATI ? String(p.NAME_STATI) : null),
    },
    {
      id: "stadtbezirk",
      label: "Stadtbezirk",
      borderLabel: "Stadtbezirksgrenze",
      code: "S",
      resolve: (p) => MUENSTER_STADTBEZIRK_MAP[String(p.STADTBEZIR ?? "").trim()] ?? null,
    },
  ],
  placeholder: "RADAR_1A2B_51.96070;7.62610;2km",
};

// ── Erfurt ────────────────────────────────────────────────────
// Data files (stops.erfurt.ts, public/erfurt/*) are produced in the data
// phase. POI nameKeys are confirmed against the real Geoportal files there.

const ERFURT_POI_LAYERS: PoiLayerConfig[] = [
  { id: "kitas", label: "Kita", file: "kitas.geojson", color: "#fdd835", nameKey: "NAME" },
  { id: "schulen", label: "Schule", file: "schulen.geojson", color: "#9c27b0", nameKey: "NAME" },
  { id: "sportstaetten", label: "Sportstätte", file: "sportstaetten.geojson", color: "#4caf50", nameKey: "NAME" },
  { id: "friedhoefe", label: "Friedhof", file: "friedhoefe.geojson", color: "#607d8b", nameKey: "NAME" },
  { id: "krankenhaeuser", label: "Krankenhaus", file: "krankenhaeuser.geojson", color: "#009688", nameKey: "NAME" },
  { id: "museen", label: "Museum", file: "museen.geojson", color: "#3f51b5", nameKey: "NAME" },
  { id: "buechereien", label: "Bücherei", file: "buechereien.geojson", color: "#00bcd4", nameKey: "NAME" },
  { id: "baeder", label: "Bad", file: "baeder.geojson", color: "#2196f3", nameKey: "NAME" },
];

const erfurt: CityConfig = {
  id: "erfurt",
  label: "Erfurt",
  center: { lat: 50.9787, lon: 11.0328 },
  hideRadiusM: 400,
  poiBasePath: "erfurt/pois/",
  stadtteileFile: "erfurt/stadtteile.geojson",
  busLinesFile: "erfurt/pois/buslinien.geojson",
  stops: ERFURT_STOPS,
  poiLayers: ERFURT_POI_LAYERS,
  districtLevels: [
    {
      id: "ortsteil",
      label: "Ortsteil",
      borderLabel: "Ortsteilgrenze",
      code: "O",
      resolve: (p) => (p.NAME ? String(p.NAME) : null),
    },
  ],
  placeholder: "RADAR_1A2B_50.97870;11.03280;2km",
};

// ── Registry ──────────────────────────────────────────────────

export const CITIES: Record<string, CityConfig> = { muenster, erfurt };
export const DEFAULT_CITY = "muenster";
export const CITY_STORAGE_KEY = "hs_city";

/** Reads the persisted city choice (JSON-stringified, like the other hs_ keys). */
export function getActiveCity(): CityConfig {
  let id = DEFAULT_CITY;
  try {
    const raw = localStorage.getItem(CITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string" && CITIES[parsed]) id = parsed;
    }
  } catch {
    /* ignore */
  }
  return CITIES[id] ?? CITIES[DEFAULT_CITY];
}
