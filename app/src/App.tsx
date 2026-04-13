import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, Popup, ScaleControl, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { STOPS } from "./data/stops";

type Role = "landing" | "hider" | "seeker";
type QuestionType = "RADAR" | "THERMO_PATH" | "MATCH_DISTRICT" | "MATCH_POI" | "MATCH_BUSLINE" | "MATCH_STREET" | "MEASURE";
type MeasureType = "kitas" | "schulen" | "sportstaetten" | "friedhoefe" | "kinos" | "krankenhaeuser" | "museen" | "buechereien" | "baeder" | "busline" | "street" | "border_bezirk" | "border_stadtbezirk";
type MatchLevel = "bezirk" | "stadtbezirk";
type RadarPreset = "0.25" | "0.5" | "1" | "2" | "custom";

type QuestionCode = {
  qid: string;
  type: QuestionType;
  payload: Record<string, unknown>;
};

type AnswerCode = {
  qid: string;
  type: QuestionType;
  answer: Record<string, unknown>;
};

type Position = { lat: number; lon: number };

type StadtteilFeature = {
  type: "Feature";
  properties: {
    NR_STATIST?: string;
    NAME_STATI?: string;
    STADTBEZIR?: string;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
};

type StadtteileCollection = {
  type: "FeatureCollection";
  features: StadtteilFeature[];
};

const MUNSTER_CENTER: Position = { lat: 51.9607, lon: 7.6261 };
const HIDE_RADIUS_M = 400;

type PoiFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Point"; coordinates: [number, number] };
};

type PoiCollection = {
  type: "FeatureCollection";
  features: PoiFeature[];
};

type PoiLayerConfig = {
  id: string;
  label: string;
  file: string;
  color: string;
  nameKey: string;
};

type BusLineFeature = {
  type: "Feature";
  properties: { route_id: string; name: string; color: string; label_lat: number; label_lon: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type BusLineCollection = {
  type: "FeatureCollection";
  features: BusLineFeature[];
};

const POI_LAYERS: PoiLayerConfig[] = [
  { id: "kitas", label: "Kitas", file: "kitas_ms.geojson", color: "#e91e63", nameKey: "E_NAME" },
  { id: "schulen", label: "Schulen", file: "schulen_ms.geojson", color: "#9c27b0", nameKey: "NAME" },
  { id: "sportstaetten", label: "Sportstätten", file: "sportstaetten.geojson", color: "#4caf50", nameKey: "Name" },
  { id: "friedhoefe", label: "Friedhöfe", file: "friedhoefe.geojson", color: "#607d8b", nameKey: "NAME" },
  { id: "kinos", label: "Kinos", file: "kinos.geojson", color: "#ff9800", nameKey: "NAME" },
  { id: "krankenhaeuser", label: "Krankenhäuser", file: "krankenhaeuser.geojson", color: "#f44336", nameKey: "NAME" },
  { id: "museen", label: "Museen", file: "museen.geojson", color: "#3f51b5", nameKey: "NAME" },
  { id: "buechereien", label: "Büchereien", file: "buechereien.geojson", color: "#00bcd4", nameKey: "NAME" },
  { id: "baeder", label: "Bäder", file: "baeder.geojson", color: "#2196f3", nameKey: "NAME" },
];

const MEASURE_TYPES: { id: MeasureType; label: string }[] = [
  { id: "border_bezirk", label: "Bezirksgrenze" },
  { id: "border_stadtbezirk", label: "Stadtbezirksgrenze" },
  ...POI_LAYERS.map((l) => ({ id: l.id as MeasureType, label: l.label })),
  { id: "street", label: "Straße" },
  { id: "busline", label: "Buslinie" },
];

const GROUP_MAP: Record<string, string> = {
  "11": "Mitte",
  "12": "Mitte",
  "13": "Mitte",
  "14": "Mitte",
  "15": "Mitte",
  "21": "Mitte",
  "22": "Mitte",
  "23": "Mitte",
  "24": "Mitte",
  "25": "Mitte",
  "26": "Mitte",
  "27": "Mitte",
  "28": "Mitte",
  "29": "Mitte",
  "31": "Mitte Süd",
  "32": "Mitte Süd",
  "33": "Mitte Süd",
  "43": "Mitte Süd",
  "46": "Mitte Nord",
  "47": "Mitte Nord",
  "44": "Mauritz",
  "45": "Mauritz",
  "71": "Mauritz",
  "34": "Berg Fidel",
  "91": "Berg Fidel",
  "62": "Kinderhaus-Ost",
  "63": "Kinderhaus-West",
  "95": "Hiltrup",
  "96": "Hiltrup",
  "97": "Hiltrup",
  "81": "Gremmendorf",
  "82": "Gremmendorf",
  "51": "Gievenbeck",
  "52": "Sentrup",
  "54": "Mecklenbeck",
  "56": "Albachten",
  "57": "Roxel",
  "58": "Nienberge",
  "61": "Coerde",
  "68": "Sprakel",
  "76": "Gelmer",
  "77": "Handorf",
  "86": "Angelmodde",
  "87": "Wolbeck",
  "98": "Amelsbüren",
};

const EXCLUDED_DISTRICTS = new Set(["Sprakel", "Nienberge", "Roxel", "Albachten", "Amelsbüren", "Wolbeck"]);

const STADTBEZIRK_MAP: Record<string, string> = {
  "1 Altstadt": "Mitte",
  "2 Innenstadtring": "Mitte",
  "3 Mitte-S\u00fcd": "Mitte",
  "4 Mitte-Nordost": "Mitte",
  "5 M\u00fcnster-West": "West",
  "6 M\u00fcnster-Nord": "Nord",
  "7 M\u00fcnster-Ost": "Ost",
  "8 M\u00fcnster-S\u00fcdost": "S\u00fcdost",
  "9 M\u00fcnster-Hiltrup": "Hiltrup",
};

const DISTRICT_COLORS = ["#e53935","#7b1fa2","#1565c0","#00695c","#e65100","#283593","#006064","#2e7d32","#f57f17","#4e342e","#0277bd","#558b2f"];
function districtColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  return DISTRICT_COLORS[hash % DISTRICT_COLORS.length];
}

function dissolveFeatures(features: StadtteilFeature[]): [number, number][][] {
  const PREC = 6;
  const pk = (x: number, y: number) => `${x.toFixed(PREC)},${y.toFixed(PREC)}`;

  // Directed edge map: fwdKey -> edge data. Shared edges (A→B + B→A) cancel out.
  const edgeMap = new Map<string, { fx: number; fy: number; tx: number; ty: number }>();

  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const fwdKey = `${pk(ax, ay)}>${pk(bx, by)}`;
    const revKey = `${pk(bx, by)}>${pk(ax, ay)}`;
    if (edgeMap.has(revKey)) {
      edgeMap.delete(revKey);
    } else {
      edgeMap.set(fwdKey, { fx: ax, fy: ay, tx: bx, ty: by });
    }
  };

  for (const feature of features) {
    const geom = feature.geometry;
    const outerRings: number[][][] =
      geom.type === "Polygon"
        ? [geom.coordinates[0] as number[][]]
        : (geom.coordinates as number[][][][]).map((poly) => poly[0]);
    for (const ring of outerRings) {
      for (let i = 0; i < ring.length - 1; i++) {
        addEdge(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      }
    }
  }

  // Build next-point and start-point lookups from remaining exterior edges
  const nextPoint = new Map<string, [number, number]>();
  const startPoints = new Map<string, [number, number]>();
  for (const edge of edgeMap.values()) {
    const fromKey = pk(edge.fx, edge.fy);
    nextPoint.set(fromKey, [edge.tx, edge.ty]);
    startPoints.set(fromKey, [edge.fx, edge.fy]);
  }

  const visited = new Set<string>();
  const result: [number, number][][] = [];

  for (const [startKey, startPt] of startPoints) {
    if (visited.has(startKey)) continue;
    const ring: [number, number][] = [startPt];
    visited.add(startKey);
    let cur = startPt;
    for (let steps = 0; steps < 100000; steps++) {
      const nxt = nextPoint.get(pk(cur[0], cur[1]));
      if (!nxt) break;
      const nxtKey = pk(nxt[0], nxt[1]);
      if (nxtKey === startKey) break;
      if (visited.has(nxtKey)) break;
      ring.push(nxt);
      visited.add(nxtKey);
      cur = nxt;
    }
    if (ring.length >= 3) result.push([...ring, ring[0]]);
  }

  return result;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function formatCoord(value: number): string {
  return value.toFixed(5);
}

function parseLocaleNumber(raw: string): number {
  const normalized = raw.replace(",", ".").trim();
  const value = Number(normalized);
  return Number.isFinite(value) ? value : Number.NaN;
}

function formatKmLocale(value: number): string {
  const normalized = Number(value.toFixed(2)).toString();
  return normalized.replace(".", ",");
}

function parseCoordPair(raw: string): [number, number] {
  const parts = raw.split(";");
  if (parts.length !== 2) throw new Error("Koordinaten fehlen.");
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error("Koordinaten ungültig.");
  return [lat, lon];
}

function encodeQuestionCode(payload: QuestionCode): string {
  if (payload.type === "RADAR") {
    const center = payload.payload.center as [number, number];
    const radiusKm = Number(payload.payload.radiusKm);
    return `RADAR_${payload.qid}_${formatCoord(center[0])};${formatCoord(center[1])};${formatKmLocale(radiusKm)}km`;
  }
  if (payload.type === "THERMO_PATH") {
    const start = payload.payload.start as [number, number];
    const end = payload.payload.end as [number, number];
    return `THERMO_${payload.qid}_${formatCoord(start[0])};${formatCoord(start[1])}_${formatCoord(end[0])};${formatCoord(end[1])}`;
  }
  if (payload.type === "MATCH_DISTRICT") {
    const level = payload.payload.level as MatchLevel;
    const ref = payload.payload.reference as [number, number];
    return `MATCH_${payload.qid}_${level === "bezirk" ? "B" : "S"}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
  }
  if (payload.type === "MATCH_POI") {
    const poiType = payload.payload.poiType as string;
    const ref = payload.payload.reference as [number, number];
    const nearest = payload.payload.nearestName as string;
    return `MPOI_${payload.qid}_${poiType}_${formatCoord(ref[0])};${formatCoord(ref[1])}_${nearest}`;
  }
  if (payload.type === "MATCH_BUSLINE") {
    const lineName = payload.payload.lineName as string;
    const ref = payload.payload.reference as [number, number];
    return `MBUS_${payload.qid}_${lineName}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
  }
  if (payload.type === "MEASURE") {
    const measureType = payload.payload.measureType as string;
    const distKm = Number(payload.payload.distKm);
    const ref = payload.payload.reference as [number, number];
    return `MEAS_${payload.qid}_${measureType}_${formatKmLocale(distKm)}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
  }
  // MATCH_STREET
  const street = payload.payload.street as string;
  const ref = payload.payload.reference as [number, number];
  return `MSTR_${payload.qid}_${formatCoord(ref[0])};${formatCoord(ref[1])}_${street}`;
}

function encodeAnswerCode(payload: AnswerCode): string {
  if (payload.type === "RADAR") {
    return `A_RADAR_${payload.qid}_${payload.answer.inside ? "JA" : "NEIN"}`;
  }
  if (payload.type === "THERMO_PATH") {
    return `A_THERMO_${payload.qid}_${String(payload.answer.trend)}`;
  }
  if (payload.type === "MATCH_DISTRICT") {
    return `A_MATCH_${payload.qid}_${payload.answer.match ? "JA" : "NEIN"}`;
  }
  if (payload.type === "MATCH_POI") {
    return `A_MPOI_${payload.qid}_${payload.answer.match ? "JA" : "NEIN"}`;
  }
  if (payload.type === "MATCH_BUSLINE") {
    return `A_MBUS_${payload.qid}_${payload.answer.match ? "JA" : "NEIN"}`;
  }
  if (payload.type === "MEASURE") {
    return `A_MEAS_${payload.qid}_${String(payload.answer.result)}`;
  }
  return `A_MSTR_${payload.qid}_${payload.answer.match ? "JA" : "NEIN"}`;
}

function decodeCode(raw: string): QuestionCode | AnswerCode {
  const radarQ = raw.match(/^RADAR_([A-Z0-9]{4})_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?);(\d+(?:[\.,]\d+)?)km$/i);
  if (radarQ) {
    const center = parseCoordPair(radarQ[2]);
    return { qid: radarQ[1].toUpperCase(), type: "RADAR", payload: { center, radiusKm: parseLocaleNumber(radarQ[3]) } };
  }

  const thermoQ = raw.match(/^THERMO_([A-Z0-9]{4})_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
  if (thermoQ) {
    return {
      qid: thermoQ[1].toUpperCase(),
      type: "THERMO_PATH",
      payload: { start: parseCoordPair(thermoQ[2]), end: parseCoordPair(thermoQ[3]) },
    };
  }

  const matchQ = raw.match(/^MATCH_([A-Z0-9]{4})_(B|S)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
  if (matchQ) {
    return {
      qid: matchQ[1].toUpperCase(),
      type: "MATCH_DISTRICT",
      payload: { level: matchQ[2].toUpperCase() === "B" ? "bezirk" : "stadtbezirk", reference: parseCoordPair(matchQ[3]) },
    };
  }

  const radarA = raw.match(/^A_RADAR_([A-Z0-9]{4})_(JA|NEIN)$/i);
  if (radarA) {
    return { qid: radarA[1].toUpperCase(), type: "RADAR", answer: { inside: radarA[2].toUpperCase() === "JA" } };
  }

  const thermoA = raw.match(/^A_THERMO_([A-Z0-9]{4})_(WARMER|COLDER|SAME)$/i);
  if (thermoA) {
    return {
      qid: thermoA[1].toUpperCase(),
      type: "THERMO_PATH",
      answer: { trend: thermoA[2].toUpperCase() as "WARMER" | "COLDER" | "SAME" },
    };
  }

  const matchA = raw.match(/^A_MATCH_([A-Z0-9]{4})_(JA|NEIN)$/i);
  if (matchA) {
    return { qid: matchA[1].toUpperCase(), type: "MATCH_DISTRICT", answer: { match: matchA[2].toUpperCase() === "JA" } };
  }

  const mpoiQ = raw.match(/^MPOI_([A-Z0-9]{4})_([a-z]+)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)_(.+)$/i);
  if (mpoiQ) {
    return {
      qid: mpoiQ[1].toUpperCase(),
      type: "MATCH_POI",
      payload: { poiType: mpoiQ[2], reference: parseCoordPair(mpoiQ[3]), nearestName: mpoiQ[4] },
    };
  }

  const mpoiA = raw.match(/^A_MPOI_([A-Z0-9]{4})_(JA|NEIN)$/i);
  if (mpoiA) {
    return { qid: mpoiA[1].toUpperCase(), type: "MATCH_POI", answer: { match: mpoiA[2].toUpperCase() === "JA" } };
  }

  const mbusQ = raw.match(/^MBUS_([A-Z0-9]{4})_(.+?)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
  if (mbusQ) {
    return {
      qid: mbusQ[1].toUpperCase(),
      type: "MATCH_BUSLINE",
      payload: { lineName: mbusQ[2], reference: parseCoordPair(mbusQ[3]) },
    };
  }

  const mbusA = raw.match(/^A_MBUS_([A-Z0-9]{4})_(JA|NEIN)$/i);
  if (mbusA) {
    return { qid: mbusA[1].toUpperCase(), type: "MATCH_BUSLINE", answer: { match: mbusA[2].toUpperCase() === "JA" } };
  }

  const mstrQ = raw.match(/^MSTR_([A-Z0-9]{4})_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)_(.+)$/i);
  if (mstrQ) {
    return {
      qid: mstrQ[1].toUpperCase(),
      type: "MATCH_STREET",
      payload: { reference: parseCoordPair(mstrQ[2]), street: mstrQ[3] },
    };
  }

  const mstrA = raw.match(/^A_MSTR_([A-Z0-9]{4})_(JA|NEIN)$/i);
  if (mstrA) {
    return { qid: mstrA[1].toUpperCase(), type: "MATCH_STREET", answer: { match: mstrA[2].toUpperCase() === "JA" } };
  }

  const measQ = raw.match(/^MEAS_([A-Z0-9]{4})_([a-z_]+)_(\d+(?:[\.,]\d+)?)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
  if (measQ) {
    return {
      qid: measQ[1].toUpperCase(),
      type: "MEASURE",
      payload: { measureType: measQ[2], distKm: parseLocaleNumber(measQ[3]), reference: parseCoordPair(measQ[4]) },
    };
  }

  const measA = raw.match(/^A_MEAS_([A-Z0-9]{4})_(CLOSER|FURTHER)$/i);
  if (measA) {
    return { qid: measA[1].toUpperCase(), type: "MEASURE", answer: { result: measA[2].toUpperCase() as "CLOSER" | "FURTHER" } };
  }

  throw new Error("Unbekanntes Code-Format");
}

function distToSegment(p: Position, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return haversineKm(p, { lat: a[1], lon: a[0] });
  let t = ((p.lon - a[0]) * dx + (p.lat - a[1]) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return haversineKm(p, { lat: a[1] + t * dy, lon: a[0] + t * dx });
}

function findNearestBusLines(pos: Position, busLines: BusLineCollection): { name: string; dist: number }[] {
  const results: { name: string; dist: number }[] = [];
  for (const feature of busLines.features) {
    const coords = feature.geometry.coordinates;
    let minDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = distToSegment(pos, coords[i], coords[i + 1]);
      if (d < minDist) minDist = d;
    }
    results.push({ name: feature.properties.name, dist: minDist });
  }
  results.sort((a, b) => a.dist - b.dist);
  if (results.length === 0) return [];
  const threshold = results[0].dist + 0.05;
  return results.filter((r) => r.dist <= threshold);
}

async function reverseGeocodeStreet(pos: Position): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${pos.lat}&lon=${pos.lon}&format=json&zoom=17`;
  const res = await fetch(url, { headers: { "Accept-Language": "de" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.address?.road ?? data?.address?.pedestrian ?? data?.address?.footway ?? data?.address?.path ?? null;
}

function findNearestPoi(pos: Position, features: PoiFeature[]): { name: string; dist: number } | null {
  if (!features.length) return null;
  let best: { name: string; dist: number } | null = null;
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    const d = haversineKm(pos, { lat, lon });
    if (!best || d < best.dist) {
      const keys = ["E_NAME", "NAME", "Name"];
      let name = "";
      for (const k of keys) {
        if (f.properties[k]) { name = String(f.properties[k]); break; }
      }
      best = { name, dist: d };
    }
  }
  return best;
}

function haversineKm(a: Position, b: Position): number {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const x = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * r * Math.asin(Math.sqrt(x));
}

function pointInRing(point: Position, ring: number[][]): boolean {
  const x = point.lon;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point: Position, geometry: StadtteilFeature["geometry"]): boolean {
  if (geometry.type === "Polygon") {
    const [outer, ...holes] = geometry.coordinates as number[][][];
    if (!pointInRing(point, outer)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  }

  const polygons = geometry.coordinates as number[][][][];
  return polygons.some((polygon) => {
    const [outer, ...holes] = polygon;
    if (!pointInRing(point, outer)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  });
}

function bezirkForFeature(feature: StadtteilFeature): string | null {
  const nr = feature.properties.NR_STATIST ?? "";
  const mapped = GROUP_MAP[nr] ?? feature.properties.NAME_STATI ?? null;
  if (!mapped) return null;
  if (EXCLUDED_DISTRICTS.has(mapped)) return null;
  return mapped;
}

function findDistrictLabel(
  point: Position,
  geojson: StadtteileCollection | null,
  level: MatchLevel,
): string | null {
  if (!geojson) return null;
  const feature = geojson.features.find((item) => pointInGeometry(point, item.geometry));
  if (!feature) return null;
  if (level === "stadtbezirk") {
    const raw = (feature.properties.STADTBEZIR ?? "").trim();
    return STADTBEZIRK_MAP[raw] ?? null;
  }
  return bezirkForFeature(feature);
}

function distPointToRing(pos: Position, ring: number[][]): number {
  let minDist = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const a: [number, number] = [ring[i][0], ring[i][1]];
    const b: [number, number] = [ring[i + 1][0], ring[i + 1][1]];
    const d = distToSegment(pos, a, b);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

function distToNearestBorder(
  pos: Position,
  geojson: StadtteileCollection | null,
  level: "bezirk" | "stadtbezirk",
): number {
  if (!geojson) return Infinity;

  if (level === "stadtbezirk") {
    let minDist = Infinity;
    for (const feature of geojson.features) {
      const geom = feature.geometry;
      const rings: number[][][] = geom.type === "Polygon"
        ? (geom.coordinates as number[][][])
        : (geom.coordinates as number[][][][]).flat();
      for (const ring of rings) {
        const d = distPointToRing(pos, ring);
        if (d < minDist) minDist = d;
      }
    }
    return minDist;
  }

  // bezirk: group features by bezirk name, merge rings per group, find min dist across all group boundaries
  const groups: Record<string, number[][][]> = {};
  for (const feature of geojson.features) {
    const name = bezirkForFeature(feature);
    if (!name) continue;
    if (!groups[name]) groups[name] = [];
    const geom = feature.geometry;
    const rings: number[][][] = geom.type === "Polygon"
      ? (geom.coordinates as number[][][])
      : (geom.coordinates as number[][][][]).flat();
    groups[name].push(...rings);
  }

  let minDist = Infinity;
  for (const rings of Object.values(groups)) {
    for (const ring of rings) {
      const d = distPointToRing(pos, ring);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

function isPointExcludedByAnswer(
  pos: Position,
  question: QuestionCode,
  answerCode: AnswerCode,
  geojson: StadtteileCollection | null,
  poiData: Record<string, PoiCollection>,
  busLines: BusLineCollection | null,
): boolean {
  if (question.type === "RADAR") {
    const center = question.payload.center as [number, number];
    const radiusKm = Number(question.payload.radiusKm);
    const dist = haversineKm(pos, { lat: center[0], lon: center[1] });
    const inside = Boolean(answerCode.answer.inside);
    return inside ? dist > radiusKm : dist <= radiusKm;
  }

  if (question.type === "THERMO_PATH") {
    const start = question.payload.start as [number, number];
    const end = question.payload.end as [number, number];
    const d1 = haversineKm(pos, { lat: start[0], lon: start[1] });
    const d2 = haversineKm(pos, { lat: end[0], lon: end[1] });
    const trend = answerCode.answer.trend as string;
    if (trend === "WARMER") return d2 >= d1;
    if (trend === "COLDER") return d2 <= d1;
    return false;
  }

  if (question.type === "MATCH_DISTRICT") {
    const level = question.payload.level as MatchLevel;
    const refPoint = question.payload.reference as [number, number];
    const posLabel = findDistrictLabel(pos, geojson, level);
    const refLabel = findDistrictLabel({ lat: refPoint[0], lon: refPoint[1] }, geojson, level);
    const match = Boolean(answerCode.answer.match);
    const isSame = posLabel !== null && posLabel === refLabel;
    return match ? !isSame : isSame;
  }

  if (question.type === "MATCH_POI") {
    const poiType = question.payload.poiType as string;
    const seekerNearest = question.payload.nearestName as string;
    const layerData = poiData[poiType];
    if (!layerData) return false;
    const posNearest = findNearestPoi(pos, layerData.features);
    if (!posNearest) return false;
    const isSame = posNearest.name === seekerNearest;
    const match = Boolean(answerCode.answer.match);
    return match ? !isSame : isSame;
  }

  if (question.type === "MATCH_BUSLINE") {
    const seekerLine = question.payload.lineName as string;
    if (!busLines) return false;
    const nearestLines = findNearestBusLines(pos, busLines);
    const hasLine = nearestLines.some((l) => l.name === seekerLine);
    const match = Boolean(answerCode.answer.match);
    return match ? !hasLine : hasLine;
  }

  if (question.type === "MEASURE") {
    const mt = question.payload.measureType as MeasureType;
    const seekerDist = Number(question.payload.distKm);
    const result = answerCode.answer.result as "CLOSER" | "FURTHER";
    let posDist: number | null = null;

    if (mt === "busline") {
      if (!busLines) return false;
      const nearest = findNearestBusLines(pos, busLines);
      posDist = nearest.length > 0 ? nearest[0].dist : null;
    } else if (mt === "street") {
      return false;
    } else if (mt === "border_bezirk" || mt === "border_stadtbezirk") {
      const level = mt === "border_bezirk" ? "bezirk" : "stadtbezirk";
      posDist = distToNearestBorder(pos, geojson, level);
      if (!Number.isFinite(posDist)) return false;
    } else {
      const layerData = poiData[mt];
      if (!layerData) return false;
      const nearest = findNearestPoi(pos, layerData.features);
      posDist = nearest ? nearest.dist : null;
    }

    if (posDist === null) return false;
    return result === "CLOSER" ? posDist >= seekerDist : posDist <= seekerDist;
  }

  return false;
}

function isPointExcluded(
  pos: Position,
  answers: AnswerCode[],
  questions: Record<string, QuestionCode>,
  geojson: StadtteileCollection | null,
  poiData: Record<string, PoiCollection>,
  busLines: BusLineCollection | null,
): boolean {
  for (const a of answers) {
    const q = questions[a.qid];
    if (!q) continue;
    if (isPointExcludedByAnswer(pos, q, a, geojson, poiData, busLines)) return true;
  }
  return false;
}

function useCurrentLocation() {
  const [position, setPosition] = useState<Position | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("Geolocation wird von diesem Browser nicht unterstützt.");
      return;
    }
    const watcher = navigator.geolocation.watchPosition(
      (next) => {
        setPosition({ lat: next.coords.latitude, lon: next.coords.longitude });
        setAccuracy(next.coords.accuracy ?? null);
      },
      (nextError) => {
        setError(nextError.message || "Standort konnte nicht geladen werden.");
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
      },
    );

    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  return { position, accuracy, error };
}

function RecenterOnPosition({ position }: { position: Position | null }) {
  const map = useMap();
  const initialized = useRef(false);
  useEffect(() => {
    if (!position || initialized.current) return;
    initialized.current = true;
    map.setView([position.lat, position.lon], 14);
  }, [map, position]);
  return null;
}

function CenterButton({ position }: { position: Position | null }) {
  const map = useMap();
  const container = map.getContainer().querySelector<HTMLElement>(".leaflet-top.leaflet-right");
  if (!container) return null;
  return createPortal(
    <div className="leaflet-control map-center-control">
      <button
        className="map-center-btn"
        onClick={() => {
          if (position) map.setView([position.lat, position.lon], 15);
        }}
        title="Zum Standort zentrieren"
        disabled={!position}
      >
        &#x2316;
      </button>
    </div>,
    container,
  );
}

function ExclusionOverlay({
  answers,
  questions,
  geojson,
  poiData,
  busLines,
}: {
  answers: AnswerCode[];
  questions: Record<string, QuestionCode>;
  geojson: StadtteileCollection | null;
  poiData: Record<string, PoiCollection>;
  busLines: BusLineCollection | null;
}) {
  const map = useMap();
  const layerRef = useRef<L.GridLayer | null>(null);

  useEffect(() => {
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }

    if (answers.length === 0) return;

    const ExclusionGrid = L.GridLayer.extend({
      createTile(coords: L.Coords) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;

        const ctx = tile.getContext("2d");
        if (!ctx) return tile;

        const step = 4;
        ctx.fillStyle = "rgba(50, 50, 50, 0.45)";

        for (let x = 0; x < size.x; x += step) {
          for (let y = 0; y < size.y; y += step) {
            const point = L.point(coords.x * size.x + x, coords.y * size.y + y);
            const latlng = map.unproject(point, coords.z);
            const pos: Position = { lat: latlng.lat, lon: latlng.lng };

            if (isPointExcluded(pos, answers, questions, geojson, poiData, busLines)) {
              ctx.fillRect(x, y, step, step);
            }
          }
        }

        return tile;
      },
    });

    const layer = new ExclusionGrid() as L.GridLayer;
    layer.addTo(map);
    layerRef.current = layer;

    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [answers, questions, geojson, poiData, busLines, map]);

  return null;
}

function copyText(value: string): void {
  navigator.clipboard.writeText(value).catch(() => {
    // ignore on unsupported clipboard
  });
}

function notifySeeker(message: string): void {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification("Thermometer", { body: message });
    return;
  }
  if (Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        new Notification("Thermometer", { body: message });
      }
    });
  }
}

function renderType(type: QuestionType): string {
  if (type === "RADAR") return "Radar";
  if (type === "THERMO_PATH") return "Thermometer";
  if (type === "MATCH_POI") return "POI-Matching";
  if (type === "MATCH_BUSLINE") return "Buslinien-Matching";
  if (type === "MATCH_STREET") return "Straßen-Matching";
  if (type === "MEASURE") return "Measuring";
  return "Matching Frage";
}

type QuestionPreview = { text: string; reward: string; time: string; doubled: boolean };

const FOTO_QUESTIONS: { id: string; label: string }[] = [
  { id: "gebaeude", label: "Gebäude" },
  { id: "breiteste_strasse", label: "Breiteste Straße" },
  { id: "baum", label: "Baum" },
  { id: "groesste_struktur", label: "Größte Struktur" },
  { id: "selfie", label: "Selfie" },
  { id: "himmel", label: "Himmel" },
  { id: "bushaltestelle", label: "Bushaltestelle" },
];

function questionSubKey(type: QuestionType, payload: Record<string, unknown>): string {
  if (type === "MATCH_DISTRICT") return `MATCH_DISTRICT_${payload.level as string}`;
  if (type === "MATCH_POI") return `MATCH_POI_${payload.poiType as string}`;
  if (type === "MATCH_BUSLINE") return `MATCH_BUSLINE_${payload.lineName as string}`;
  if (type === "MEASURE") return `MEASURE_${payload.measureType as string}`;
  return type;
}

function translateQuestionCode(decoded: QuestionCode): QuestionPreview {
  function rewardFor(type: QuestionType): { reward: string; time: string } {
    if (type === "RADAR" || type === "THERMO_PATH") return { reward: "2 Karten ziehen, 1 behalten", time: "3 min" };
    if (type === "MATCH_DISTRICT" || type === "MATCH_POI" || type === "MATCH_BUSLINE" || type === "MATCH_STREET") return { reward: "3 Karten ziehen, 1 behalten", time: "3 min" };
    if (type === "MEASURE") return { reward: "3 Karten ziehen, 1 behalten", time: "3 min" };
    return { reward: "", time: "" };
  }
  const { reward, time } = rewardFor(decoded.type);
  if (decoded.type === "RADAR") {
    const radiusKm = Number(decoded.payload.radiusKm);
    const meters = Math.round(radiusKm * 1000);
    return { text: `Bist du im Umkreis von ${meters} Metern von uns?`, reward, time, doubled: false };
  }
  if (decoded.type === "THERMO_PATH") {
    const start = decoded.payload.start as [number, number];
    const end = decoded.payload.end as [number, number];
    const km = haversineKm({ lat: start[0], lon: start[1] }, { lat: end[0], lon: end[1] });
    const meters = Math.round(km * 1000);
    return { text: `Wir sind ${meters} Meter gelaufen, sind wir jetzt näher dran oder weiter weg?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_DISTRICT") {
    const level = decoded.payload.level as string;
    const label = level === "bezirk" ? "Bezirk" : "Stadtbezirk";
    return { text: `Bist du im gleichen ${label} wie wir?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_POI") {
    const poiType = decoded.payload.poiType as string;
    const name = decoded.payload.nearestName as string;
    const label = POI_LAYERS.find((l) => l.id === poiType)?.label ?? poiType;
    return { text: `Ist unser nächster ${label} \u201e${name}\u201c auch dein nächster ${label}?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_BUSLINE") {
    const line = decoded.payload.lineName as string;
    return { text: `Ist unsere nächste Buslinie (Linie ${line}) auch deine nächste Buslinie?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_STREET") {
    const street = decoded.payload.street as string;
    return { text: `Sind wir auf der gleichen Straße? (Unsere Straße: ${street})`, reward, time, doubled: false };
  }
  if (decoded.type === "MEASURE") {
    const mt = decoded.payload.measureType as MeasureType;
    const distKm = Number(decoded.payload.distKm);
    const meters = Math.round(distKm * 1000);
    const label = MEASURE_TYPES.find((m) => m.id === mt)?.label ?? mt;
    return { text: `Wir sind ${meters} Meter von einem ${label} entfernt. Bist du näher dran oder weiter entfernt von einem ${label} als wir?`, reward, time, doubled: false };
  }
  return { text: "Unbekannte Frage", reward: "", time: "", doubled: false };
}

function App() {
  const [role, setRole] = useState<Role>(() => (localStorage.getItem("hs_role") as Role) || "landing");
  const [geojson, setGeojson] = useState<StadtteileCollection | null>(null);
  const [geojsonError, setGeojsonError] = useState<string>("");
  const [selectedStopId, setSelectedStopId] = useState<string>(() => localStorage.getItem("hs_hideout") || "");

  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);

  const [hiderInputCode, setHiderInputCode] = useState("");
  const [hiderFeedback, setHiderFeedback] = useState("");
  const [hiderAnswerCode, setHiderAnswerCode] = useState("");
  const [questionPreview, setQuestionPreview] = useState<QuestionPreview | null>(null);

  const [radarPreset, setRadarPreset] = useState<RadarPreset>("1");
  const [radarCustomKmInput, setRadarCustomKmInput] = useState("0,2");
  const [thermoStart, setThermoStart] = useState<Position | null>(null);
  const [thermoEnd, setThermoEnd] = useState<Position | null>(null);
  const [thermoTracking, setThermoTracking] = useState<{
    active: boolean;
    targetKm: number;
    walkedKm: number;
    lastPos: Position | null;
  }>({ active: false, targetKm: 0.75, walkedKm: 0, lastPos: null });
  const matchLevel: MatchLevel = "bezirk";
  const selectedPoiType = POI_LAYERS[0].id;
  const [selectedBusLine, setSelectedBusLine] = useState<string>("");
  const selectedMeasureType: MeasureType = "kitas";
  const [usedFotoQuestions, setUsedFotoQuestions] = useState<Record<string, boolean>>({});
  const [fotoConfirmQuestion, setFotoConfirmQuestion] = useState<string | null>(null);

  const [askedCodes, setAskedCodes] = useState<Record<string, QuestionCode>>({});
  const [latestQuestionCode, setLatestQuestionCode] = useState("");
  const questionCodeRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (latestQuestionCode) {
      questionCodeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [latestQuestionCode]);
  const [answerInput, setAnswerInput] = useState("");
  const [answerFeedback, setAnswerFeedback] = useState("");
  const [appliedAnswers, setAppliedAnswers] = useState<Record<string, AnswerCode>>({});

  const usedSubKeys = useMemo(
    () =>
      new Set(
        Object.keys(appliedAnswers)
          .filter((qid) => askedCodes[qid])
          .map((qid) => questionSubKey(askedCodes[qid].type, askedCodes[qid].payload)),
      ),
    [appliedAnswers, askedCodes],
  );

  const [poiData, setPoiData] = useState<Record<string, PoiCollection>>({});
  const [poiVisible, setPoiVisible] = useState<Record<string, boolean>>(() => Object.fromEntries(POI_LAYERS.map((l) => [l.id, false])));
  const [poiMenuOpen, setPoiMenuOpen] = useState(false);
  const [busLines, setBusLines] = useState<BusLineCollection | null>(null);
  const [busLinesVisible, setBusLinesVisible] = useState(false);
  const [busLegendOpen, setBusLegendOpen] = useState(false);
  const [bezirkBorderVisible, setBezirkBorderVisible] = useState(false);
  const [stadtbezirkBorderVisible, setStadtbezirkBorderVisible] = useState(false);

  const { position: currentPos, accuracy, error: geolocationError } = useCurrentLocation();

  useEffect(() => {
    POI_LAYERS.forEach((layer) => {
      fetch(`${import.meta.env.BASE_URL}pois/${layer.file}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<PoiCollection>;
        })
        .then((data) => setPoiData((prev) => ({ ...prev, [layer.id]: data })))
        .catch(() => { /* silently skip unavailable layers */ });
    });

    fetch(`${import.meta.env.BASE_URL}pois/buslinien.geojson`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<BusLineCollection>;
      })
      .then((data) => setBusLines(data))
      .catch(() => { /* silently skip */ });
  }, []);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}stadtteile-muenster.geojson`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((res) => {
        const collection = res as StadtteileCollection;
        setGeojson(collection);
      })
      .catch((err: Error) => {
        fetch("./stadtteile-muenster.geojson")
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json() as Promise<unknown>;
          })
          .then((res) => setGeojson(res as StadtteileCollection))
          .catch(() => setGeojsonError(err.message));
      });
  }, []);

  useEffect(() => {
    localStorage.setItem("hs_role", role);
  }, [role]);

  useEffect(() => {
    if (selectedStopId) localStorage.setItem("hs_hideout", selectedStopId);
  }, [selectedStopId]);

  const selectedStop = useMemo(() => STOPS.find((stop) => stop.id === selectedStopId) || null, [selectedStopId]);
  const radarKm = useMemo(() => {
    if (radarPreset === "custom") {
      const parsed = parseLocaleNumber(radarCustomKmInput);
      if (!Number.isFinite(parsed)) return 0.2;
      return Math.max(0.05, parsed);
    }
    return Number(radarPreset);
  }, [radarCustomKmInput, radarPreset]);

  useEffect(() => {
    if (!thermoTracking.active || !currentPos) return;
    if (!thermoTracking.lastPos) {
      setThermoTracking((prev) => ({ ...prev, lastPos: currentPos }));
      return;
    }

    const deltaKm = haversineKm(thermoTracking.lastPos, currentPos);
    if (deltaKm < 0.005) return;

    const nextWalked = thermoTracking.walkedKm + deltaKm;
    if (nextWalked >= thermoTracking.targetKm) {
      setThermoEnd(currentPos);
      setThermoTracking((prev) => ({ ...prev, active: false, walkedKm: nextWalked, lastPos: currentPos }));
      const doneMsg = `Ziel erreicht: ${thermoTracking.targetKm.toFixed(2)} km gelaufen. Endpunkt wurde gesetzt.`;
      setAnswerFeedback(doneMsg);
      notifySeeker(doneMsg);
      return;
    }

    setThermoTracking((prev) => ({ ...prev, walkedKm: nextWalked, lastPos: currentPos }));
  }, [currentPos, thermoTracking]);

  const activeAnswers = useMemo(() => Object.values(appliedAnswers), [appliedAnswers]);

  const bezirkGroups = useMemo(() => {
    if (!geojson) return new Map<string, [number, number][][]>();
    const groups = new Map<string, StadtteilFeature[]>();
    for (const feat of geojson.features) {
      const name = bezirkForFeature(feat);
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(feat);
    }
    const result = new Map<string, [number, number][][]>();
    for (const [name, feats] of groups) result.set(name, dissolveFeatures(feats));
    return result;
  }, [geojson]);

  const stadtbezirkGroups = useMemo(() => {
    if (!geojson) return new Map<string, [number, number][][]>();
    const groups = new Map<string, StadtteilFeature[]>();
    for (const feat of geojson.features) {
      const sb = (feat.properties.STADTBEZIR ?? "").trim();
      const name = STADTBEZIRK_MAP[sb];
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(feat);
    }
    const result = new Map<string, [number, number][][]>();
    for (const [name, feats] of groups) result.set(name, dissolveFeatures(feats));
    return result;
  }, [geojson]);

  const filteredStops = useMemo(() => {
    if (activeAnswers.length === 0) return STOPS;

    // For each stop, sample 17 points (center + 8 on 400m ring + 8 on 200m ring).
    // If ALL sample points are excluded, the stop is filtered out.
    const HIDE_RADIUS_KM = HIDE_RADIUS_M / 1000;
    const SAMPLE_ANGLES = 8;

    function samplePoints(center: Position, radiusKm: number): Position[] {
      const points: Position[] = [center];
      const latPerKm = 1 / 111.32;
      const lonPerKm = 1 / (111.32 * Math.cos((center.lat * Math.PI) / 180));
      for (const r of [radiusKm, radiusKm / 2]) {
        for (let i = 0; i < SAMPLE_ANGLES; i++) {
          const angle = (2 * Math.PI * i) / SAMPLE_ANGLES;
          points.push({
            lat: center.lat + Math.sin(angle) * r * latPerKm,
            lon: center.lon + Math.cos(angle) * r * lonPerKm,
          });
        }
      }
      return points;
    }

    return STOPS.filter((stop) => {
      const samples = samplePoints({ lat: stop.lat, lon: stop.lon }, HIDE_RADIUS_KM);
      return !samples.every((pt) =>
        isPointExcluded(pt, activeAnswers, askedCodes, geojson, poiData, busLines),
      );
    });
  }, [activeAnswers, askedCodes, geojson, poiData, busLines]);

  type GenOpts = { level?: MatchLevel; poiType?: string; lineName?: string; measureType?: MeasureType };
  async function generateQuestion(type: QuestionType, opts?: GenOpts): Promise<void> {
    if (!currentPos) return;

    let payload: Record<string, unknown> = {};

    if (type === "RADAR") {
      payload = {
        center: [currentPos.lat, currentPos.lon],
        radiusKm: radarKm,
      };
    }

    if (type === "THERMO_PATH") {
      if (!thermoStart || !thermoEnd) {
        setAnswerFeedback("Bitte zuerst Start- und Endpunkt setzen.");
        return;
      }
      payload = {
        start: [thermoStart.lat, thermoStart.lon],
        end: [thermoEnd.lat, thermoEnd.lon],
      };
    }

    if (type === "MATCH_DISTRICT") {
      payload = {
        level: opts?.level ?? matchLevel,
        reference: [currentPos.lat, currentPos.lon],
      };
    }

    if (type === "MATCH_POI") {
      const poiType = opts?.poiType ?? selectedPoiType;
      const layerData = poiData[poiType];
      if (!layerData) {
        setAnswerFeedback("POI-Daten noch nicht geladen.");
        return;
      }
      const nearest = findNearestPoi(currentPos, layerData.features);
      if (!nearest) {
        setAnswerFeedback("Keine POIs gefunden.");
        return;
      }
      payload = {
        poiType,
        reference: [currentPos.lat, currentPos.lon],
        nearestName: nearest.name,
      };
    }

    if (type === "MATCH_BUSLINE") {
      const lineName = opts?.lineName ?? selectedBusLine;
      if (!lineName) {
        setAnswerFeedback("Bitte eine Buslinie auswählen.");
        return;
      }
      payload = {
        lineName,
        reference: [currentPos.lat, currentPos.lon],
      };
    }

    if (type === "MATCH_STREET") {
      setAnswerFeedback("Straße wird ermittelt...");
      const street = await reverseGeocodeStreet(currentPos);
      if (!street) {
        setAnswerFeedback("Straße konnte nicht ermittelt werden.");
        return;
      }
      payload = {
        reference: [currentPos.lat, currentPos.lon],
        street,
      };
    }

    if (type === "MEASURE") {
      const mt = opts?.measureType ?? selectedMeasureType;
      let distKm: number | null = null;

      if (mt === "busline") {
        if (!busLines) { setAnswerFeedback("Buslinien-Daten nicht geladen."); return; }
        const nearest = findNearestBusLines(currentPos, busLines);
        distKm = nearest.length > 0 ? nearest[0].dist : null;
      } else if (mt === "street") {
        setAnswerFeedback("Straßenabstand wird ermittelt...");
        const street = await reverseGeocodeStreet(currentPos);
        if (!street) { setAnswerFeedback("Straße konnte nicht ermittelt werden."); return; }
        // For street we use 0 as "on this street" — distance is conceptually 0 at your position
        distKm = 0;
      } else if (mt === "border_bezirk" || mt === "border_stadtbezirk") {
        const level = mt === "border_bezirk" ? "bezirk" : "stadtbezirk";
        distKm = distToNearestBorder(currentPos, geojson, level);
        if (!Number.isFinite(distKm)) { setAnswerFeedback("Grenzabstand konnte nicht berechnet werden."); return; }
      } else {
        // POI type
        const layerData = poiData[mt];
        if (!layerData) { setAnswerFeedback("POI-Daten noch nicht geladen."); return; }
        const nearest = findNearestPoi(currentPos, layerData.features);
        if (!nearest) { setAnswerFeedback("Keine POIs gefunden."); return; }
        distKm = nearest.dist;
      }

      if (distKm === null) { setAnswerFeedback("Abstand konnte nicht berechnet werden."); return; }
      payload = {
        measureType: mt,
        distKm,
        reference: [currentPos.lat, currentPos.lon],
      };
    }

    const question: QuestionCode = {
      qid: randomId(),
      type,
      payload,
    };

    setAskedCodes((prev) => ({ ...prev, [question.qid]: question }));
    const code = encodeQuestionCode(question);
    setLatestQuestionCode(code);
    setAnswerFeedback(`${renderType(type)}-Code erstellt.`);
  }

  function startThermometer(targetKm: number): void {
    if (!currentPos) {
      setAnswerFeedback("Aktueller Standort fehlt. Bitte GPS freigeben.");
      return;
    }
    setThermoStart(currentPos);
    setThermoEnd(null);
    setThermoTracking({
      active: true,
      targetKm,
      walkedKm: 0,
      lastPos: currentPos,
    });
    setAnswerFeedback(`Thermometer gestartet: laufe ${targetKm.toFixed(2)} km.`);
  }

  function resetThermometer(): void {
    setThermoStart(null);
    setThermoEnd(null);
    setThermoTracking((prev) => ({ ...prev, active: false, walkedKm: 0, lastPos: null }));
  }

  async function evaluateHiderCode(): Promise<void> {
    try {
      if (!currentPos) {
        setHiderFeedback("Standort wird benötigt – GPS freigeben.");
        return;
      }
      const decoded = decodeCode(hiderInputCode.trim());
      if (!("payload" in decoded)) {
        setHiderFeedback("Bitte einen Fragecode einfügen (RADAR_/THERMO_/MATCH_...).");
        return;
      }

      const realPos = currentPos;
      let answer: Record<string, unknown> = {};
      let feedback = "";

      if (decoded.type === "RADAR") {
        const center = decoded.payload.center as [number, number];
        const radiusKm = Number(decoded.payload.radiusKm);
        const inside = haversineKm(realPos, { lat: center[0], lon: center[1] }) <= radiusKm;
        answer = { inside };
        feedback = inside ? "Radar: JA, im Umkreis." : "Radar: NEIN, außerhalb.";
      }

      if (decoded.type === "THERMO_PATH") {
        const start = decoded.payload.start as [number, number];
        const end = decoded.payload.end as [number, number];
        const d1 = haversineKm(realPos, { lat: start[0], lon: start[1] });
        const d2 = haversineKm(realPos, { lat: end[0], lon: end[1] });
        let trend: "WARMER" | "COLDER" | "SAME" = "SAME";
        if (d2 < d1 - 0.02) trend = "WARMER";
        else if (d2 > d1 + 0.02) trend = "COLDER";
        answer = { trend };
        feedback = `Thermometer: ${trend}`;
      }

      if (decoded.type === "MATCH_DISTRICT") {
        const level = decoded.payload.level as MatchLevel;
        const reference = decoded.payload.reference as [number, number];
        const hiderLabel = findDistrictLabel(realPos, geojson, level);
        const refLabel = findDistrictLabel({ lat: reference[0], lon: reference[1] }, geojson, level);
        const match = Boolean(hiderLabel && refLabel && hiderLabel === refLabel);
        answer = { match };
        feedback = match ? "Matching: JA" : "Matching: NEIN";
      }

      if (decoded.type === "MATCH_POI") {
        const poiType = decoded.payload.poiType as string;
        const seekerNearest = decoded.payload.nearestName as string;
        const layerData = poiData[poiType];
        if (!layerData) {
          setHiderFeedback(`POI-Daten für "${poiType}" nicht geladen.`);
          return;
        }
        const hiderNearest = findNearestPoi(realPos, layerData.features);
        const match = Boolean(hiderNearest && hiderNearest.name === seekerNearest);
        answer = { match };
        const poiLabel = POI_LAYERS.find((l) => l.id === poiType)?.label ?? poiType;
        feedback = match
          ? `POI-Matching (${poiLabel}): JA – gleicher nächster POI (${seekerNearest})`
          : `POI-Matching (${poiLabel}): NEIN – dein nächster: ${hiderNearest?.name ?? "?"}, Sucher: ${seekerNearest}`;
      }

      if (decoded.type === "MATCH_BUSLINE") {
        const seekerLine = decoded.payload.lineName as string;
        if (!busLines) {
          setHiderFeedback("Buslinien-Daten nicht geladen.");
          return;
        }
        const nearestLines = findNearestBusLines(realPos, busLines);
        const lineNames = nearestLines.map((l) => l.name);
        const match = lineNames.includes(seekerLine);
        answer = { match };
        feedback = match
          ? `Buslinien-Matching: JA – Linie ${seekerLine} gehört zu deinen nächsten (${lineNames.join(", ")})`
          : `Buslinien-Matching: NEIN – deine nächsten: ${lineNames.join(", ") || "keine"}, Sucher: ${seekerLine}`;
      }

      if (decoded.type === "MATCH_STREET") {
        setHiderFeedback("Straße wird ermittelt...");
        const seekerStreet = decoded.payload.street as string;
        const hiderStreet = await reverseGeocodeStreet(realPos);
        const match = Boolean(hiderStreet && hiderStreet === seekerStreet);
        answer = { match };
        feedback = match
          ? `Straßen-Matching: JA – gleiche Straße (${seekerStreet})`
          : `Straßen-Matching: NEIN – deine Straße: ${hiderStreet ?? "?"}, Sucher: ${seekerStreet}`;
      }

      if (decoded.type === "MEASURE") {
        const mt = decoded.payload.measureType as MeasureType;
        const seekerDist = Number(decoded.payload.distKm);
        let hiderDist: number | null = null;

        if (mt === "busline") {
          if (!busLines) { setHiderFeedback("Buslinien-Daten nicht geladen."); return; }
          const nearest = findNearestBusLines(realPos, busLines);
          hiderDist = nearest.length > 0 ? nearest[0].dist : null;
        } else if (mt === "street") {
          hiderDist = 0;
        } else if (mt === "border_bezirk" || mt === "border_stadtbezirk") {
          const level = mt === "border_bezirk" ? "bezirk" : "stadtbezirk";
          hiderDist = distToNearestBorder(realPos, geojson, level);
          if (!Number.isFinite(hiderDist)) hiderDist = null;
        } else {
          const layerData = poiData[mt];
          if (!layerData) { setHiderFeedback(`POI-Daten für "${mt}" nicht geladen.`); return; }
          const nearest = findNearestPoi(realPos, layerData.features);
          hiderDist = nearest ? nearest.dist : null;
        }

        if (hiderDist === null) { setHiderFeedback("Abstand konnte nicht berechnet werden."); return; }
        const diff = hiderDist - seekerDist;
        const result: "CLOSER" | "FURTHER" = diff <= 0 ? "CLOSER" : "FURTHER";

        answer = { result };
        const label = MEASURE_TYPES.find((m) => m.id === mt)?.label ?? mt;
        feedback = `Measuring (${label}): ${result} (du: ${hiderDist.toFixed(2)} km, Sucher: ${seekerDist.toFixed(2)} km)`;
      }

      const answerCode: AnswerCode = {
        qid: decoded.qid,
        type: decoded.type,
        answer,
      };

      setHiderFeedback(feedback);
      setHiderAnswerCode(encodeAnswerCode(answerCode));
      setHiderInputCode("");
      setQuestionPreview(null);
    } catch (err) {
      setHiderFeedback(`Code ungültig: ${(err as Error).message}`);
    }
  }

  function applyAnswerCode(): void {
    try {
      const decoded = decodeCode(answerInput.trim());
      if (!("answer" in decoded)) {
        setAnswerFeedback("Bitte einen Antwortcode einfügen (A_RADAR_/A_THERMO_/A_MATCH_...).");
        return;
      }
      if (!askedCodes[decoded.qid]) {
        setAnswerFeedback("Antwort passt zu keiner erzeugten Frage.");
        return;
      }
      setAppliedAnswers((prev) => ({ ...prev, [decoded.qid]: decoded }));
      setAnswerFeedback("Antwort angewendet. Karte wurde gefiltert.");
    } catch (err) {
      setAnswerFeedback(`Antwort ungültig: ${(err as Error).message}`);
    }
  }

  const displayedStops = role === "seeker" ? filteredStops : STOPS;

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Hide and Seek</h1>
        <div className="topbar-right">
          {role !== "landing" && (
            <button className="btn ghost" onClick={() => setRole("landing")}>
              Zur Startseite
            </button>
          )}
        </div>
      </header>

      {role === "landing" && (
        <main className="landing">
          <h2>Rolle auswahlen</h2>
          <p>Starte als Verstecker oder Sucher. Beide nutzen dieselbe Karte und denselben Code-Standard.</p>
          <div className="landing-actions">
            <button className="btn" onClick={() => setRole("hider")}>
              Verstecker
            </button>
            <button className="btn secondary" onClick={() => setRole("seeker")}>
              Sucher
            </button>
          </div>
        </main>
      )}

      {role !== "landing" && (
        <main className="game-layout">
          <aside className="panel">
            {role === "hider" && (
              <>
                <h2>Verstecker</h2>
                <p className="meta">Wahle eine Haltestelle auf der Karte als Versteck.</p>
                <div className="row">
                  <label>Aktuelles Versteck</label>
                  <strong>{selectedStop?.name ?? "Noch nicht gewahlt"}</strong>
                </div>

                {hiderAnswerCode && (
                  <div className="card" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
                    <label style={{ color: "#166534", fontWeight: 700 }}>Letzter Antwortcode</label>
                    <textarea readOnly value={hiderAnswerCode} style={{ fontSize: "0.85rem" }} />
                    <button className="btn ghost" onClick={() => copyText(hiderAnswerCode)}>Rauskopieren</button>
                  </div>
                )}

                <div className="row">
                  <label>Fragecode vom Sucher</label>
                    <textarea
                      value={hiderInputCode}
                      onChange={(e) => {
                        const val = e.target.value;
                        setHiderInputCode(val);
                        setHiderFeedback("");
                        setHiderAnswerCode("");
                        try {
                          const decoded = decodeCode(val.trim());
                          if ("payload" in decoded) {
                            const preview = translateQuestionCode(decoded);
                            const subKey = questionSubKey(decoded.type, decoded.payload);
                            const doubled = usedSubKeys.has(subKey);
                            setQuestionPreview({ ...preview, doubled });
                          }
                        } catch {
                          setQuestionPreview(null);
                        }
                      }}
                      placeholder="RADAR_1A2B_51.96070;7.62610;2km"
                    />
                </div>

                {questionPreview !== null && (
                  <div className="question-preview-overlay" onClick={() => setQuestionPreview(null)}>
                    <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                      <p className="question-preview-text">{questionPreview.text}</p>
                      <div className="question-preview-meta">
                        <span>🎴 {questionPreview.doubled ? <><s>{questionPreview.reward}</s> <strong style={{color:"#16a34a"}}>{questionPreview.reward.replace(/\d+(?= Karten)/, (n) => String(Number(n)*2))}</strong> (2×)</> : questionPreview.reward}</span>
                        <span>⏱️ {questionPreview.time}</span>
                      </div>
                      {questionPreview.doubled && (
                        <p className="meta small" style={{ color: "#b45309", margin: 0 }}>⚠️ Diese Frage wurde bereits gestellt – doppelte Belohnung!</p>
                      )}
                      <button
                        className="btn"
                        onClick={async () => {
                          await evaluateHiderCode();
                        }}
                      >
                        Code auswerten
                      </button>
                      {hiderFeedback && <p className="meta" style={{ margin: 0 }}>{hiderFeedback}</p>}
                      {hiderAnswerCode && (
                        <>
                          <textarea readOnly value={hiderAnswerCode} style={{ width: "100%", resize: "none", fontSize: "0.85rem" }} />
                          <button className="btn ghost" onClick={() => { copyText(hiderAnswerCode); }}>Rauskopieren</button>
                        </>
                      )}
                      <button className="btn ghost" onClick={() => setQuestionPreview(null)}>Schließen</button>
                    </div>
                  </div>
                )}

                {confirmStopId !== null && (() => {
                  const confirmStop = STOPS.find((s) => s.id === confirmStopId);
                  return (
                    <div className="question-preview-overlay" onClick={() => setConfirmStopId(null)}>
                      <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                        <p className="question-preview-text">
                          <strong>{confirmStop?.name}</strong> als Versteck festlegen?
                        </p>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            className="btn"
                            style={{ flex: 1 }}
                            onClick={() => {
                              setSelectedStopId(confirmStopId);
                              setConfirmStopId(null);
                            }}
                          >
                            Ja
                          </button>
                          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setConfirmStopId(null)}>
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="card">
                  <h3>Belohnungen &amp; Zeitlimits</h3>
                  <ul className="foto-fragen-list">
                    <li><strong>Radar</strong> — 2 Karten ziehen, 1 behalten · 3 min</li>
                    <li><strong>Thermometer</strong> — 2 Karten ziehen, 1 behalten · 3 min</li>
                    <li><strong>Matching</strong> — 3 Karten ziehen, 1 behalten · 3 min</li>
                    <li><strong>Measuring</strong> — 3 Karten ziehen, 1 behalten · 3 min</li>
                    <li><strong>Foto</strong> — 1 Karte ziehen, 1 behalten · 10 min</li>
                  </ul>
                </div>
              </>
            )}

            {role === "seeker" && (
              <>
                <h2>Sucher</h2>
                <p className="meta">Erzeuge Fragen, sende den Code und trage die Antwort wieder ein.</p>

                <div className="card" data-cat="radar">
                  <h3>Radar</h3>
                  <p className="meta small">Belohnung: 2 Karten ziehen, 1 behalten · Zeitlimit: 3 min</p>
                  <label>Radius</label>
                  <div className="split-buttons">
                    <button className={`btn ghost ${radarPreset === "0.25" ? "active-btn" : ""}`} onClick={() => setRadarPreset("0.25")}>250 m</button>
                    <button className={`btn ghost ${radarPreset === "0.5" ? "active-btn" : ""}`} onClick={() => setRadarPreset("0.5")}>500 m</button>
                    <button className={`btn ghost ${radarPreset === "1" ? "active-btn" : ""}`} onClick={() => setRadarPreset("1")}>1 km</button>
                    <button className={`btn ghost ${radarPreset === "2" ? "active-btn" : ""}`} onClick={() => setRadarPreset("2")}>2 km</button>
                    <button className={`btn ghost ${radarPreset === "custom" ? "active-btn" : ""}`} onClick={() => setRadarPreset("custom")}>Custom</button>
                  </div>
                  {radarPreset === "custom" && (
                    <input
                      type="text"
                      inputMode="decimal"
                      value={radarCustomKmInput}
                      onChange={(e) => setRadarCustomKmInput(e.target.value)}
                      placeholder="z. B. 0,2"
                    />
                  )}
                  <p className="meta small">Aktiv: {formatKmLocale(radarKm)} km</p>
                  <button className={`q-btn${usedSubKeys.has("RADAR") ? " q-btn--used" : ""}`} onClick={() => generateQuestion("RADAR")}>Radar-Code erzeugen</button>
                </div>

                <div className="card" data-cat="thermo">
                  <h3>Thermometer</h3>
                  <p className="meta small">Belohnung: 2 Karten ziehen, 1 behalten · Zeitlimit: 3 min</p>
                  <div className="split-buttons">
                    <button className="btn ghost" onClick={() => startThermometer(0.75)}>
                      Start 750 m
                    </button>
                    <button className="btn ghost" onClick={() => startThermometer(1.5)}>
                      Start 1,5 km
                    </button>
                  </div>
                  <p className="meta small">
                    Start: {thermoStart ? `${thermoStart.lat.toFixed(5)}, ${thermoStart.lon.toFixed(5)}` : "-"}
                    <br />
                    Ziel: {thermoEnd ? `${thermoEnd.lat.toFixed(5)}, ${thermoEnd.lon.toFixed(5)}` : "-"}
                    <br />
                    Status: {thermoTracking.active ? "Laeuft" : "Inaktiv"}
                    {thermoTracking.active && (
                      <>
                        <br />
                        Gelaufen: {thermoTracking.walkedKm.toFixed(2)} / {thermoTracking.targetKm.toFixed(2)} km
                      </>
                    )}
                  </p>
                  <button className="btn ghost" onClick={resetThermometer}>Thermometer zuruecksetzen</button>
                  <button className={`q-btn${usedSubKeys.has("THERMO_PATH") ? " q-btn--used" : ""}`} onClick={() => generateQuestion("THERMO_PATH")}>Thermometer-Code erzeugen</button>
                </div>

                <div className="card" data-cat="matching">
                  <h3>Matching</h3>
                  <p className="meta small">Belohnung: 3 Karten ziehen, 1 behalten · Zeitlimit: 3 min</p>
                  <div className="q-grid">
                    <button className={`q-btn${usedSubKeys.has("MATCH_DISTRICT_bezirk") ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MATCH_DISTRICT", { level: "bezirk" })}>Bezirk</button>
                    <button className={`q-btn${usedSubKeys.has("MATCH_DISTRICT_stadtbezirk") ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MATCH_DISTRICT", { level: "stadtbezirk" })}>Stadtbezirk</button>
                    {POI_LAYERS.map((l) => (
                      <button key={l.id} className={`q-btn${usedSubKeys.has(`MATCH_POI_${l.id}`) ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MATCH_POI", { poiType: l.id })}>{l.label}</button>
                    ))}
                    <button className={`q-btn${usedSubKeys.has("MATCH_STREET") ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MATCH_STREET")}>Straße</button>
                  </div>
                  <div className="q-busline-row">
                    <select value={selectedBusLine} onChange={(e) => setSelectedBusLine(e.target.value)}>
                      <option value="">– Buslinie wählen –</option>
                      {busLines && busLines.features.map((f) => (
                        <option key={f.properties.route_id} value={f.properties.name}>Linie {f.properties.name}</option>
                      ))}
                    </select>
                    <button className={`q-btn${selectedBusLine && usedSubKeys.has(`MATCH_BUSLINE_${selectedBusLine}`) ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MATCH_BUSLINE")}>Buslinie →</button>
                  </div>
                </div>

                <div className="card" data-cat="measuring">
                  <h3>Measuring</h3>
                  <p className="meta small">Belohnung: 3 Karten ziehen, 1 behalten · Zeitlimit: 3 min</p>
                  <div className="q-grid">
                    {MEASURE_TYPES.map((m) => (
                      <button key={m.id} className={`q-btn${usedSubKeys.has(`MEASURE_${m.id}`) ? " q-btn--used" : ""}`} onClick={() => generateQuestion("MEASURE", { measureType: m.id })}>{m.label}</button>
                    ))}
                  </div>
                </div>

                <div className="card" data-cat="foto">
                  <h3>Foto</h3>
                  <p className="meta small">Belohnung: 1 Karte ziehen, 1 behalten · Zeitlimit: 10 min</p>
                  <div className="q-grid">
                    {FOTO_QUESTIONS.map((q) => (
                      <button key={q.id} className={`q-btn${usedFotoQuestions[q.id] ? " q-btn--used" : ""}`} onClick={() => setFotoConfirmQuestion(q.id)}>{q.label}</button>
                    ))}
                  </div>
                </div>

                {fotoConfirmQuestion !== null && (() => {
                  const fq = FOTO_QUESTIONS.find((q) => q.id === fotoConfirmQuestion);
                  return (
                    <div className="question-preview-overlay" onClick={() => setFotoConfirmQuestion(null)}>
                      <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                        <p className="question-preview-text">Foto-Frage stellen: <strong>{fq?.label}</strong>?</p>
                        <div className="question-preview-meta">
                          <span>🎴 1 Karte ziehen, 1 behalten</span>
                          <span>⏱️ 10 min</span>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn" style={{ flex: 1 }} onClick={() => {
                            setUsedFotoQuestions((prev) => ({ ...prev, [fotoConfirmQuestion]: true }));
                            setFotoConfirmQuestion(null);
                          }}>Ja, stellen</button>
                          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setFotoConfirmQuestion(null)}>Abbrechen</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="row" ref={questionCodeRowRef}>
                  <textarea readOnly value={latestQuestionCode} />
                  <button className="btn ghost" onClick={() => copyText(latestQuestionCode)}>
                    Rauskopieren
                  </button>
                </div>

                <div className="row">
                  <label>Antwortcode eintragen</label>
                  <textarea value={answerInput} onChange={(e) => setAnswerInput(e.target.value)} placeholder="A_RADAR_1A2B_JA" />
                  <button className="btn" onClick={applyAnswerCode}>
                    Antwort anwenden
                  </button>
                  <p className="meta">{answerFeedback}</p>
                </div>

                <div className="row">
                  <label>Aktive Filter</label>
                  <p className="meta small">
                    {Object.keys(appliedAnswers).length} Antworten aktiv · {filteredStops.length} Haltestellen verbleiben
                  </p>
                </div>
              </>
            )}

            {(geolocationError || geojsonError) && (
              <div className="warn">
                {geolocationError && <div>Standort: {geolocationError}</div>}
                {geojsonError && <div>GeoJSON: {geojsonError}</div>}
              </div>
            )}

            <div className="poi-menu">
              <button className="poi-menu-toggle" onClick={() => setPoiMenuOpen((v) => !v)}>
                <span className="poi-menu-arrow">{poiMenuOpen ? "▾" : "▸"}</span>
                POI-Ebenen
              </button>
              {poiMenuOpen && (
                <div className="poi-menu-list">
                  <label className="poi-menu-item">
                    <input
                      type="checkbox"
                      checked={bezirkBorderVisible}
                      onChange={() => setBezirkBorderVisible((v) => !v)}
                    />
                    <span className="poi-color-dot" style={{ background: "#795548" }} />
                    Bezirksgrenzen
                  </label>
                  <label className="poi-menu-item">
                    <input
                      type="checkbox"
                      checked={stadtbezirkBorderVisible}
                      onChange={() => setStadtbezirkBorderVisible((v) => !v)}
                    />
                    <span className="poi-color-dot" style={{ background: "#607d8b" }} />
                    Stadtbezirksgrenzen
                  </label>
                  <label className="poi-menu-item">
                    <input
                      type="checkbox"
                      checked={busLinesVisible}
                      onChange={() => setBusLinesVisible((v) => !v)}
                    />
                    <span className="poi-color-dot" style={{ background: "#e30613" }} />
                    Buslinien
                    {busLines && <span className="poi-count">({busLines.features.length})</span>}
                  </label>
                  {POI_LAYERS.map((layer) => (
                    <label key={layer.id} className="poi-menu-item">
                      <input
                        type="checkbox"
                        checked={poiVisible[layer.id] ?? false}
                        onChange={() => setPoiVisible((prev) => ({ ...prev, [layer.id]: !prev[layer.id] }))}
                      />
                      <span className="poi-color-dot" style={{ background: layer.color }} />
                      {layer.label}
                      {poiData[layer.id] && <span className="poi-count">({poiData[layer.id].features.length})</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {busLinesVisible && busLines && (
              <div className="poi-menu bus-legend">
                <button className="poi-menu-toggle" onClick={() => setBusLegendOpen((v) => !v)}>
                  <span className="poi-menu-arrow">{busLegendOpen ? "▾" : "▸"}</span>
                  Buslinien-Legende
                </button>
                {busLegendOpen && (
                  <div className="poi-menu-list bus-legend-grid">
                    {busLines.features.map((f) => (
                      <span key={f.properties.route_id} className="bus-legend-item">
                        <span className="bus-legend-line" style={{ background: f.properties.color }} />
                        {f.properties.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>

          <section className="map-wrap">
            <MapContainer center={[MUNSTER_CENTER.lat, MUNSTER_CENTER.lon]} zoom={13} scrollWheelZoom className="map">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              />

              <RecenterOnPosition position={currentPos} />
              <CenterButton position={currentPos} />
              <ScaleControl position="bottomleft" imperial={false} />

              {role === "seeker" && (
                <ExclusionOverlay
                  answers={activeAnswers}
                  questions={askedCodes}
                  geojson={geojson}
                  poiData={poiData}
                  busLines={busLines}
                />
              )}

              {(() => {
                // Hider: show only selected stop with permanent radius
                if (role === "hider" && selectedStop) {
                  return (
                    <>
                      <Circle
                        center={[selectedStop.lat, selectedStop.lon]}
                        radius={HIDE_RADIUS_M}
                        pathOptions={{ color: "#0f172a", weight: 1.5, fillColor: "#94a3b8", fillOpacity: 0.15 }}
                      />
                      <CircleMarker
                        center={[selectedStop.lat, selectedStop.lon]}
                        radius={8}
                        pathOptions={{ color: "#0f172a", weight: 2.4, fillColor: "#dc2626", fillOpacity: 0.9 }}
                      >
                        <Popup>
                          <b>{selectedStop.name}</b>
                        </Popup>
                      </CircleMarker>
                    </>
                  );
                }

                // Hider (no hideout yet) or Seeker: show all stops
                const stopsToShow = role === "hider" ? STOPS : displayedStops;
                return stopsToShow.map((stop) => {
                  const seekerOut = role === "seeker" && !filteredStops.some((item) => item.id === stop.id);
                  return (
                    <CircleMarker
                      key={stop.id}
                      center={[stop.lat, stop.lon]}
                      radius={6}
                      pathOptions={{
                        color: "#7f1d1d",
                        weight: 1.4,
                        fillColor: seekerOut ? "#cbd5e1" : "#dc2626",
                        fillOpacity: seekerOut ? 0.25 : 0.9,
                      }}
                      eventHandlers={{}}
                    >
                      <Popup>
                        <b>{stop.name}</b>
                        {role === "hider" && (
                          <>
                            <br />
                            <button
                              className="btn"
                              style={{ marginTop: 8, width: "100%" }}
                              onClick={() => setConfirmStopId(stop.id)}
                            >
                              Als Versteck auswählen
                            </button>
                          </>
                        )}
                      </Popup>
                    </CircleMarker>
                  );
                });
              })()}

              {bezirkBorderVisible && [...bezirkGroups.entries()].flatMap(([name, rings]) => {
                const color = districtColor(name);
                return rings.map((ring, ri) => (
                  <Polygon
                    key={`bz-${name}-${ri}`}
                    positions={ring.map(([lon, lat]) => [lat, lon] as [number, number])}
                    pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: 0.08 }}
                  >
                    {ri === 0 && <Tooltip sticky>{name}</Tooltip>}
                  </Polygon>
                ));
              })}

              {stadtbezirkBorderVisible && [...stadtbezirkGroups.entries()].flatMap(([name, rings]) => {
                const color = districtColor(name);
                return rings.map((ring, ri) => (
                  <Polygon
                    key={`sb-${name}-${ri}`}
                    positions={ring.map(([lon, lat]) => [lat, lon] as [number, number])}
                    pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: 0.08 }}
                  >
                    {ri === 0 && <Tooltip sticky>{name}</Tooltip>}
                  </Polygon>
                ));
              })}

              {busLinesVisible && busLines && busLines.features.map((feature) => {
                const coords = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
                return (
                  <Polyline
                    key={`bus-${feature.properties.route_id}`}
                    positions={coords}
                    pathOptions={{ color: feature.properties.color, weight: 3, opacity: 0.8 }}
                  >
                    <Tooltip permanent direction="center" className="bus-line-label" offset={[0, 0]}>
                      {feature.properties.name}
                    </Tooltip>
                  </Polyline>
                );
              })}

              {POI_LAYERS.map((layer) =>
                poiVisible[layer.id] && poiData[layer.id]
                  ? poiData[layer.id].features.map((feature, idx) => {
                      const [lon, lat] = feature.geometry.coordinates;
                      const name = String(feature.properties[layer.nameKey] ?? "");
                      return (
                        <CircleMarker
                          key={`${layer.id}-${idx}`}
                          center={[lat, lon]}
                          radius={5}
                          pathOptions={{
                            color: layer.color,
                            weight: 1.2,
                            fillColor: layer.color,
                            fillOpacity: 0.7,
                          }}
                        >
                          <Popup>
                            <b>{name || layer.label}</b>
                          </Popup>
                        </CircleMarker>
                      );
                    })
                  : null,
              )}

              {currentPos && (
                <>
                  <CircleMarker
                    center={[currentPos.lat, currentPos.lon]}
                    radius={7}
                    pathOptions={{ color: "#0369a1", fillColor: "#0ea5e9", fillOpacity: 0.95, weight: 2 }}
                  >
                    <Popup>Dein aktueller Standort</Popup>
                  </CircleMarker>
                  {accuracy && (
                    <Circle
                      center={[currentPos.lat, currentPos.lon]}
                      radius={accuracy}
                      pathOptions={{ color: "#38bdf8", fillColor: "#7dd3fc", fillOpacity: 0.1 }}
                    />
                  )}
                </>
              )}
            </MapContainer>
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
