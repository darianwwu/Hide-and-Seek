import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Circle, CircleMarker, MapContainer, Marker, Pane, Polygon, Polyline, Popup, ScaleControl, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { getActiveCity, CITIES, CITY_STORAGE_KEY } from "./data/cities";
import type {
  Position,
  PoiFeature,
  PoiCollection,
  BusLineCollection,
  StadtteilFeature,
  StadtteileCollection,
} from "./data/cities";

const CITY = getActiveCity();
const STOPS = CITY.stops;
type StopLike = typeof STOPS[number];
const BORDER_COLORS = ["#795548", "#607d8b", "#5d4037", "#455a64"];

function switchCity(id: string): void {
  if (id === CITY.id) return;
  try {
    ["hs_hideout", "hs_hiderUsed", "hs_usedFoto", "hs_askedCodes", "hs_latestCode", "hs_appliedAnswers"].forEach((k) =>
      localStorage.removeItem(k),
    );
    localStorage.setItem(CITY_STORAGE_KEY, JSON.stringify(id));
  } catch {
    /* ignore */
  }
  window.location.reload();
}

type Role = "landing" | "hider" | "seeker";
type QuestionType = "RADAR" | "THERMO_PATH" | "MATCH_DISTRICT" | "MATCH_POI" | "MATCH_BUSLINE" | "MEASURE";
type MeasureType = string;
type MatchLevel = string;
type RadarPreset = "0.1" | "0.25" | "0.5" | "1" | "2" | "custom";

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

const MEASURE_TYPES: { id: MeasureType; label: string }[] = [
  ...CITY.districtLevels.map((l) => ({ id: `border_${l.id}`, label: l.borderLabel })),
  ...CITY.poiLayers.map((l) => ({ id: l.id, label: l.label })),
];

type LonLat = [number, number];
type DistrictShape = { rings: LonLat[][]; color: string };
type MapClickPopup =
  | { type: "stop"; stopId: string }
  | { type: "district"; name: string; position: Position };

const DISTRICT_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#be123c",
  "#4d7c0f",
  "#9333ea",
  "#0f766e",
  "#c2410c",
  "#4338ca",
];

function ringArea(ring: LonLat[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function normalizedOuterRing(rawRing: number[][]): LonLat[] {
  const ring = rawRing.map((p) => [p[0], p[1]] as LonLat);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
  return ringArea(ring) < 0 ? [...ring].reverse() : ring;
}

function outerRings(feature: StadtteilFeature): LonLat[][] {
  const geom = feature.geometry;
  const rawRings: number[][][] =
    geom.type === "Polygon"
      ? [geom.coordinates[0] as number[][]]
      : (geom.coordinates as number[][][][]).map((poly) => poly[0]);
  return rawRings.map(normalizedOuterRing).filter((ring) => ring.length >= 4);
}

function dissolveFeatures(features: StadtteilFeature[]): LonLat[][] {
  const PREC = 6;
  const pk = (p: LonLat) => `${p[0].toFixed(PREC)},${p[1].toFixed(PREC)}`;

  type BoundaryEdge = {
    key: string;
    fromKey: string;
    toKey: string;
    from: LonLat;
    to: LonLat;
    visited: boolean;
  };

  // Directed edge map: fwdKey -> edge data. Shared edges (A→B + B→A) cancel out.
  const edgeMap = new Map<string, BoundaryEdge>();

  const addEdge = (from: LonLat, to: LonLat) => {
    const fromKey = pk(from);
    const toKey = pk(to);
    const fwdKey = `${fromKey}>${toKey}`;
    const revKey = `${toKey}>${fromKey}`;
    if (edgeMap.has(revKey)) {
      edgeMap.delete(revKey);
    } else {
      edgeMap.set(fwdKey, { key: fwdKey, fromKey, toKey, from, to, visited: false });
    }
  };

  for (const feature of features) {
    for (const ring of outerRings(feature)) {
      for (let i = 0; i < ring.length - 1; i++) {
        addEdge(ring[i], ring[i + 1]);
      }
    }
  }

  const outgoing = new Map<string, BoundaryEdge[]>();
  for (const edge of edgeMap.values()) {
    if (!outgoing.has(edge.fromKey)) outgoing.set(edge.fromKey, []);
    outgoing.get(edge.fromKey)!.push(edge);
  }

  const turnScore = (prev: BoundaryEdge, next: BoundaryEdge): number => {
    const a1 = Math.atan2(prev.to[1] - prev.from[1], prev.to[0] - prev.from[0]);
    const a2 = Math.atan2(next.to[1] - next.from[1], next.to[0] - next.from[0]);
    let turn = a2 - a1;
    while (turn <= 0) turn += Math.PI * 2;
    return turn;
  };

  const result: LonLat[][] = [];
  const minRingArea = 1e-7;

  for (const startEdge of edgeMap.values()) {
    if (startEdge.visited) continue;
    const ring: LonLat[] = [startEdge.from];
    let current = startEdge;
    let closed = false;

    for (let steps = 0; steps < edgeMap.size + 5; steps++) {
      current.visited = true;
      ring.push(current.to);

      if (current.toKey === startEdge.fromKey) {
        closed = true;
        break;
      }

      const candidates = (outgoing.get(current.toKey) ?? []).filter((edge) => !edge.visited);
      if (candidates.length === 0) break;
      current = candidates.reduce((best, edge) => (turnScore(current, edge) > turnScore(current, best) ? edge : best));
    }

    if (closed && ring.length >= 4 && Math.abs(ringArea(ring)) > minRingArea) result.push(ring);
  }

  return result;
}

function buildDistrictAdjacency(groups: Map<string, StadtteilFeature[]>): Map<string, Set<string>> {
  const PREC = 6;
  const pk = (p: LonLat) => `${p[0].toFixed(PREC)},${p[1].toFixed(PREC)}`;
  const edgeOwners = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();

  for (const name of groups.keys()) adjacency.set(name, new Set());

  for (const [name, features] of groups) {
    for (const feature of features) {
      for (const ring of outerRings(feature)) {
        for (let i = 0; i < ring.length - 1; i++) {
          const a = pk(ring[i]);
          const b = pk(ring[i + 1]);
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (!edgeOwners.has(key)) edgeOwners.set(key, new Set());
          edgeOwners.get(key)!.add(name);
        }
      }
    }
  }

  for (const owners of edgeOwners.values()) {
    const names = [...owners];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        adjacency.get(names[i])!.add(names[j]);
        adjacency.get(names[j])!.add(names[i]);
      }
    }
  }

  return adjacency;
}

function assignDistrictColors(groups: Map<string, StadtteilFeature[]>): Map<string, string> {
  const adjacency = buildDistrictAdjacency(groups);
  const colorByName = new Map<string, string>();
  const names = [...groups.keys()].sort((a, b) => {
    const degreeDiff = (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0);
    return degreeDiff || a.localeCompare(b, "de");
  });

  for (const name of names) {
    const used = new Set([...adjacency.get(name)!].map((neighbor) => colorByName.get(neighbor)).filter(Boolean));
    colorByName.set(name, DISTRICT_COLORS.find((color) => !used.has(color)) ?? DISTRICT_COLORS[0]);
  }

  return colorByName;
}

function CategoryCard({
  id,
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="card question-category" data-cat={id}>
      <button type="button" className="category-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="poi-menu-arrow">{open ? "▾" : "▸"}</span>
        <span>
          <span className="category-title">{title}</span>
          <span className="meta small">{meta}</span>
        </span>
      </button>
      {open && <div className="category-body">{children}</div>}
    </div>
  );
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
    // `exact` radars (100 m / 250 m) carry a trailing ;GPS marker; everything
    // else (500 m / 1 km / 2 km / Custom) is evaluated against the bus stop.
    const exact = Boolean(payload.payload.exact);
    return `RADAR_${payload.qid}_${formatCoord(center[0])};${formatCoord(center[1])};${formatKmLocale(radiusKm)}km${exact ? ";GPS" : ""}`;
  }
  if (payload.type === "THERMO_PATH") {
    const start = payload.payload.start as [number, number];
    const end = payload.payload.end as [number, number];
    const targetKm = Number(payload.payload.targetKm);
    return `THERMO_${payload.qid}_${formatCoord(start[0])};${formatCoord(start[1])}_${formatCoord(end[0])};${formatCoord(end[1])}_${formatKmLocale(targetKm)}km`;
  }
  if (payload.type === "MATCH_DISTRICT") {
    const level = payload.payload.level as string;
    const ref = payload.payload.reference as [number, number];
    const code = CITY.districtLevels.find((l) => l.id === level)?.code ?? "B";
    return `MATCH_${payload.qid}_${code}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
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
  // MEASURE
  const measureType = payload.payload.measureType as string;
  const distKm = Number(payload.payload.distKm);
  const ref = payload.payload.reference as [number, number];
  return `MEAS_${payload.qid}_${measureType}_${formatKmLocale(distKm)}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
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
  // MEASURE
  return `A_MEAS_${payload.qid}_${String(payload.answer.result)}`;
}

function decodeCode(raw: string): QuestionCode | AnswerCode {
  const radarQ = raw.match(/^RADAR_([A-Z0-9]{4})_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?);(\d+(?:[.,]\d+)?)km(;GPS)?$/i);
  if (radarQ) {
    const center = parseCoordPair(radarQ[2]);
    return {
      qid: radarQ[1].toUpperCase(),
      type: "RADAR",
      payload: { center, radiusKm: parseLocaleNumber(radarQ[3]), exact: Boolean(radarQ[4]) },
    };
  }

  const thermoQ = raw.match(/^THERMO_([A-Z0-9]{4})_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)(?:_(\d+(?:[.,]\d+)?)km)?$/i);
  if (thermoQ) {
    const payload: Record<string, unknown> = { start: parseCoordPair(thermoQ[2]), end: parseCoordPair(thermoQ[3]) };
    if (thermoQ[4]) payload.targetKm = parseLocaleNumber(thermoQ[4]);
    return {
      qid: thermoQ[1].toUpperCase(),
      type: "THERMO_PATH",
      payload,
    };
  }

  const matchQ = raw.match(/^MATCH_([A-Z0-9]{4})_([A-Z])_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
  if (matchQ) {
    const letter = matchQ[2].toUpperCase();
    const level = CITY.districtLevels.find((l) => l.code === letter)?.id ?? CITY.districtLevels[0]?.id ?? "bezirk";
    return {
      qid: matchQ[1].toUpperCase(),
      type: "MATCH_DISTRICT",
      payload: { level, reference: parseCoordPair(matchQ[3]) },
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

  const measQ = raw.match(/^MEAS_([A-Z0-9]{4})_([a-z_]+)_(\d+(?:[.,]\d+)?)_(-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?)$/i);
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

function findDistrictLabel(
  point: Position,
  geojson: StadtteileCollection | null,
  level: MatchLevel,
): string | null {
  if (!geojson) return null;
  const levelConfig = CITY.districtLevels.find((l) => l.id === level);
  if (!levelConfig) return null;
  const feature = geojson.features.find((item) => pointInGeometry(point, item.geometry));
  if (!feature) return null;
  return levelConfig.resolve(feature.properties);
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

// Distance to the nearest district boundary line (any level — every level's
// polygons share the same Stadtteil/Ortsteil ring edges in this data).
function distToNearestBorder(pos: Position, geojson: StadtteileCollection | null): number {
  if (!geojson) return Infinity;
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

    if (mt.startsWith("border_")) {
      posDist = distToNearestBorder(pos, geojson);
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

const ANSWER_TYPE_COST: Record<string, number> = {
  RADAR: 0,
  THERMO_PATH: 1,
  MATCH_DISTRICT: 2,
  MATCH_POI: 3,
  MATCH_BUSLINE: 4,
  MEASURE: 6,
};

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
  const [error, setError] = useState<string>(() =>
    navigator.geolocation ? "" : "Geolocation wird von diesem Browser nicht unterstützt.",
  );

  useEffect(() => {
    if (!navigator.geolocation) {
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

function MapClickResolver({
  stops,
  geojson,
  districtLevel,
  onStop,
  onDistrict,
}: {
  stops: StopLike[];
  geojson: StadtteileCollection | null;
  districtLevel: MatchLevel | null;
  onStop: (stopId: string) => void;
  onDistrict: (name: string, position: Position) => void;
}) {
  const map = useMapEvents({
    click(e) {
      const clicked = map.latLngToLayerPoint(e.latlng);
      let nearest: { stop: StopLike; px: number } | null = null;
      for (const stop of stops) {
        const point = map.latLngToLayerPoint([stop.lat, stop.lon]);
        const px = clicked.distanceTo(point);
        if (!nearest || px < nearest.px) nearest = { stop, px };
      }

      if (nearest && nearest.px <= 30) {
        onStop(nearest.stop.id);
        return;
      }

      if (!districtLevel) return;
      const position = { lat: e.latlng.lat, lon: e.latlng.lng };
      const district = findDistrictLabel(position, geojson, districtLevel);
      if (district) onDistrict(district, position);
    },
  });

  return null;
}

// Distance (in metres) that the bottom-left scale bar currently represents.
// Mirrors Leaflet's ScaleControl: it measures the ground distance across the
// first `maxWidth` (=100px) of the map and rounds it down to a "nice" number.
function scaleRoundMeters(map: L.Map): number {
  const y = Math.round(map.getSize().y / 2);
  const maxWidth = 100; // matches Leaflet ScaleControl default
  const left = map.containerPointToLatLng([0, y]);
  const right = map.containerPointToLatLng([maxWidth, y]);
  const maxMeters = left.distanceTo(right);
  if (!Number.isFinite(maxMeters) || maxMeters <= 0) return 0;
  const pow10 = Math.pow(10, String(Math.floor(maxMeters)).length - 1);
  let d = maxMeters / pow10;
  d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return pow10 * d;
}

// Clustering turns off once the scale bar shows 500 m or less (i.e. zoomed in
// far enough). Above that the markers are grid-clustered.
const CLUSTER_MAX_SCALE_M = 500;
const CLUSTER_CELL_PX = 70;

type StopMarkerHandlers = {
  role: Role;
  onStopClick: () => void;
  onPopupOpen: (id: string) => void;
  onPopupClose: () => void;
  onSelectHideout: (id: string) => void;
};

function StopCircleMarker({ stop, handlers }: { stop: StopLike; handlers: StopMarkerHandlers }) {
  return (
    <CircleMarker
      center={[stop.lat, stop.lon]}
      radius={6}
      pathOptions={{ color: "#7f1d1d", weight: 1.4, fillColor: "#dc2626", fillOpacity: 0.9 }}
      eventHandlers={{
        click: handlers.onStopClick,
        popupopen: () => handlers.onPopupOpen(stop.id),
        popupclose: handlers.onPopupClose,
      }}
    >
      <Popup>
        <b>{stop.name}</b>
        {handlers.role === "hider" && (
          <>
            <br />
            <button
              className="btn"
              style={{ marginTop: 8, width: "100%" }}
              onClick={() => handlers.onSelectHideout(stop.id)}
            >
              Als Versteck auswählen
            </button>
          </>
        )}
      </Popup>
    </CircleMarker>
  );
}

type ClusterGroup = { lat: number; lon: number; stops: StopLike[] };

function ClusteredStops({ stops, handlers }: { stops: StopLike[]; handlers: StopMarkerHandlers }) {
  const [tick, setTick] = useState(0);
  const map = useMapEvents({
    zoomend: () => setTick((t) => t + 1),
    moveend: () => setTick((t) => t + 1),
  });

  const { singles, clusters } = useMemo(() => {
    void tick; // recompute whenever the map view changes
    const clusteringOn = scaleRoundMeters(map) > CLUSTER_MAX_SCALE_M;
    if (!clusteringOn) {
      return { singles: stops, clusters: [] as ClusterGroup[] };
    }
    const zoom = map.getZoom();
    const cells = new Map<string, StopLike[]>();
    for (const s of stops) {
      const pt = map.project([s.lat, s.lon], zoom);
      const key = `${Math.floor(pt.x / CLUSTER_CELL_PX)}:${Math.floor(pt.y / CLUSTER_CELL_PX)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(s);
      else cells.set(key, [s]);
    }
    const singlesOut: StopLike[] = [];
    const clustersOut: ClusterGroup[] = [];
    for (const bucket of cells.values()) {
      if (bucket.length === 1) {
        singlesOut.push(bucket[0]);
        continue;
      }
      let sumLat = 0;
      let sumLon = 0;
      for (const s of bucket) {
        sumLat += s.lat;
        sumLon += s.lon;
      }
      clustersOut.push({ lat: sumLat / bucket.length, lon: sumLon / bucket.length, stops: bucket });
    }
    return { singles: singlesOut, clusters: clustersOut };
  }, [stops, map, tick]);

  return (
    <>
      {singles.map((stop) => (
        <StopCircleMarker key={stop.id} stop={stop} handlers={handlers} />
      ))}
      {clusters.map((c) => {
        const count = c.stops.length;
        const size = count < 10 ? 34 : count < 100 ? 40 : 48;
        const icon = L.divIcon({
          html: `<div class="cluster-marker" style="width:${size}px;height:${size}px"><span>${count}</span></div>`,
          className: "cluster-marker-wrap",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
        return (
          <Marker
            key={`cluster-${c.lat.toFixed(5)}-${c.lon.toFixed(5)}-${count}`}
            position={[c.lat, c.lon]}
            icon={icon}
            eventHandlers={{
              click: () => {
                const bounds = L.latLngBounds(c.stops.map((s) => [s.lat, s.lon] as [number, number]));
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
              },
            }}
          />
        );
      })}
    </>
  );
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
  if (type === "MEASURE") return "Measuring";
  return "Matching Frage";
}

type QuestionPreview = { text: string; reward: string; time: string; doubled: boolean; note?: string };

const FOTO_QUESTIONS: { id: string; label: string; description: string }[] = [
  { id: "gebaeude", label: "Gebäude", description: "Irgendein Gebäude was du aus deiner aktuellen Position aus sehen kannst. Es müssen beide Seiten und das Dach zu sehen sein und das Dach muss im oberen Drittel des Bildes liegen." },
  { id: "breiteste_strasse", label: "Breiteste Straße", description: "Die breiteste Straße in deinem Gebiet. Muss beide Seiten der Straße beinhalten." },
  { id: "baum", label: "Baum", description: "Muss den ganzen Baum vom Boden bis zur Spitze beinhalten." },
  { id: "groesste_struktur", label: "Größte Struktur", description: "Foto von dem höchsten Objekt in deiner aktuellen Sichtlinie. Wenn möglich, müssen beide Seiten zu sehen sein." },
  { id: "selfie", label: "Selfie", description: "Ein Selfie von dir, Arm ganz ausgestreckt und parallel zum Boden." },
  { id: "himmel", label: "Himmel", description: "Handy parallel zum Boden und direkt nach oben fotografieren." },
  { id: "bushaltestelle", label: "Bushaltestelle", description: "Deine Bushaltestelle, Häuschen oder Bank muss ganz zu sehen sein." },
];

type QCatEntry = { subKey: string; label: string; reward: string; time: string };
const QUESTION_CATEGORIES: { group: string; reward: string; time: string; items: QCatEntry[] }[] = [
  { group: "Radar", reward: "2 Karten ziehen, 1 behalten", time: "3 min", items: [
    { subKey: "RADAR_0.1", label: "100 m", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "RADAR_0.25", label: "250 m", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "RADAR_0.5", label: "500 m", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "RADAR_1", label: "1 km", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "RADAR_2", label: "2 km", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "RADAR_custom", label: "Custom", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
  ]},
  { group: "Thermometer", reward: "2 Karten ziehen, 1 behalten", time: "3 min", items: [
    { subKey: "THERMO_PATH_0.75", label: "750 m", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
    { subKey: "THERMO_PATH_1.5", label: "1,5 km", reward: "2 Karten ziehen, 1 behalten", time: "3 min" },
  ]},
  { group: "Matching", reward: "3 Karten ziehen, 1 behalten", time: "3 min", items: [
    ...CITY.districtLevels.map((l) => ({ subKey: `MATCH_DISTRICT_${l.id}`, label: l.label, reward: "3 Karten ziehen, 1 behalten", time: "3 min" })),
    ...CITY.poiLayers.map((l) => ({ subKey: `MATCH_POI_${l.id}`, label: l.label, reward: "3 Karten ziehen, 1 behalten", time: "3 min" })),
  ]},
  { group: "Measuring", reward: "3 Karten ziehen, 1 behalten", time: "3 min", items: [
    ...MEASURE_TYPES.map((m) => ({ subKey: `MEASURE_${m.id}`, label: m.label, reward: "3 Karten ziehen, 1 behalten", time: "3 min" })),
  ]},
  { group: "Foto", reward: "1 Karte ziehen, 1 behalten", time: "10 min", items: [
    ...FOTO_QUESTIONS.map((q) => ({ subKey: `FOTO_${q.id}`, label: q.label, reward: "1 Karte ziehen, 1 behalten", time: "10 min" })),
  ]},
];

// The 10 curse cards shown in the "Flüche 1-10" section (Verstecker reference).
const CURSES: { title: string; description: string; cost: string }[] = [
  {
    title: "Fluch der KiKa-Figuren",
    description:
      "Die Sucher suchen sich drei KiKa Figuren aus und weisen ihnen jeweils eine Zahl auf dem Würfel zu. Dann wird gewürfelt. Kommt eine Zahl einer Figur, müssen die Sucher zur Figur gehen und ein Foto mit dieser machen bevor die nächste Frage gestellt werden darf. Kommt eine andere Zahl, passiert nichts.",
    cost: "Legt eine Zeitbonus-Karte und einen anderen Fluch ab.",
  },
  {
    title: "Fluch der gemalten KiKa-Figuren",
    description:
      "Schickt einem Sucher privat drei KiKa Figuren. Er hat dann 3 Minuten Zeit, drei Bilder mit Bleistift von diesen Figuren zu malen. Wenn der andere Sucher alle drei richtig errät, ist der Fluch gebrochen und es darf die nächste Frage gestellt werden. Nach einem gescheiterten Versuch muss 5 Minuten gewartet werden und die Verstecker dürfen sich in der Zeit 3 neue Figuren aussuchen. Die Sucher dürfen sich beide jederzeit eine vollständige Liste mit Fotos der Figuren anschauen.",
    cost: "Werft einen Würfel. Würfelt ihr eine 6, hat diese Karte keinen Effekt.",
  },
  {
    title: "Fluch der Banane",
    description:
      "Die Sucher müssen pro Teammitglied eine Banane kaufen und essen. Die Bananen dürfen nicht im gleichen Geschäft gekauft werden (wohl aber z. B. in verschiedenen Geschäften innerhalb eines Einkaufszentrums). Erst danach darf die nächste Frage gestellt werden.",
    cost: "Kauft selber eine Banane. Wenn in eurem Versteckradius keine Bananen verkauft werden, habt ihr Glück und müsst nichts tun.",
  },
  {
    title: "Fluch der gefärbten Haare",
    description:
      "Ihr habt fünf Minuten Zeit, möglichst viele verschiedene Leute mit bunt gefärbten Haaren zu fotografieren. Teilt eure Zahl dann den Suchern mit. Schaffen sie es nicht, in 5 Minuten mindestens genau so viele verschiedene Leute mit bunt gefärbten Haaren zu fotografieren, dürft ihr die obersten zwei Karten ziehen und behalten.",
    cost: "Fotos von Leuten mit bunt gefärbten Haaren.",
  },
  {
    title: "Fluch der Flucht",
    description:
      "Ein Sucher muss sich (ohne sich mit dem Anderen abzusprechen) in 3 Minuten so verstecken, dass er mindestens 100 Meter vom Anderen entfernt ist und nicht vom aktuellen Standpunkt zu sehen ist. Der Andere hält sich so lange die Augen zu und muss nach Ablauf der 3 Minuten den Anderen ohne Kommunikation finden, bevor die nächste Frage gestellt werden darf. Gelingt dies nach 15 Minuten nicht, dürfen sich die Sucher wieder treffen, aber erst nach weiteren 15 Minuten die nächste Frage stellen.",
    cost: "Werft einen Würfel. Bei einer ungeraden Zahl hat diese Karte keinen Effekt.",
  },
  {
    title: "Fluch des Dialekts",
    description:
      "Die Sucher müssen sich 5 Minuten nur auf thüringischem Dialekt unterhalten. Spricht einer von ihnen Hochdeutsch, dürfen sie sich erst nach 15 weiteren Minuten wieder unterhalten. Anderweitige Kommunikation (z. B. über Text) ist verboten. Mimik und Gestik sind erlaubt.",
    cost: "Werft einen Würfel. Würfelt ihr eine 1 oder 2, hat diese Karte keinen Effekt.",
  },
  {
    title: "Fluch der Warteschlange",
    description:
      "„Erst anstellen!“ Die Sucher müssen sich an einer echten Schlange mit mindestens 3 Personen anstellen (Bäckerei, Supermarktkasse, Imbiss) und etwas kaufen. Dabei müssen sie jede Person, die sich hinter ihnen anstellt, fragen, ob sie vor möchte (bis eine Person nein sagt). Sie dürfen die nächste Frage erst stellen, wenn sie an der Reihe waren und bezahlt haben.",
    cost: "Legt eine Zeitbonus-Karte ab.",
  },
  {
    title: "Fluch des Kommunismus",
    description:
      "Ab sofort herrscht Planwirtschaft: Die Sucher dürfen ihre nächste Frage nicht mehr frei wählen. Die Verstecker geben ihnen zwei Kategorien vor, aus denen die nächsten beiden Fragen stammen müssen.",
    cost: "Werft einen Würfel. Bei einer geraden Zahl hat diese Karte keinen Effekt.",
  },
  {
    title: "Fluch des Kollektivs",
    description:
      "Individualismus ist abgeschafft. Die Sucher dürfen sich für die nächsten 15 Minuten nicht weiter als 2 Meter voneinander trennen und jede Nachricht muss mit dem Präfix „per einstimmigem Beschluss verkündet das Volk:“ versehen werden.",
    cost: "Legt eine Zeitbonus-Karte ab.",
  },
  {
    title: "Fluch der Mangelwirtschaft",
    description:
      "Die Sucher müssen in einem Laden ein tatsächlich leergeräumtes Regal oder ein „Ausverkauft“-Schild finden und fotografieren, bevor die nächste Frage gestellt werden darf.",
    cost: "Werft einen Würfel. Bei einer geraden Zahl hat diese Karte keinen Effekt.",
  },
];

function qBtnCls(key: string, counts: Map<string, number>): string {
  const c = counts.get(key) ?? 0;
  if (c >= 2) return " q-btn--exhausted";
  if (c >= 1) return " q-btn--used";
  return "";
}

function doubleReward(reward: string): string {
  return reward.replace(/(\d+)/g, (_, n) => String(Number(n) * 2));
}

const RADAR_PRESETS = new Set(["0.1", "0.25", "0.5", "1", "2"]);

function questionSubKey(type: QuestionType, payload: Record<string, unknown>): string {
  if (type === "RADAR") {
    const r = String(payload.radiusKm);
    return RADAR_PRESETS.has(r) ? `RADAR_${r}` : "RADAR_custom";
  }
  if (type === "THERMO_PATH") {
    const t = String(payload.targetKm ?? "");
    return t ? `THERMO_PATH_${t}` : "THERMO_PATH";
  }
  if (type === "MATCH_DISTRICT") return `MATCH_DISTRICT_${payload.level as string}`;
  if (type === "MATCH_POI") return `MATCH_POI_${payload.poiType as string}`;
  if (type === "MATCH_BUSLINE") return `MATCH_BUSLINE_${payload.lineName as string}`;
  if (type === "MEASURE") return `MEASURE_${payload.measureType as string}`;
  return type;
}

function translateQuestionCode(decoded: QuestionCode): QuestionPreview {
  function rewardFor(type: QuestionType): { reward: string; time: string } {
    if (type === "RADAR" || type === "THERMO_PATH") return { reward: "2 Karten ziehen, 1 behalten", time: "3 min" };
    if (type === "MATCH_DISTRICT" || type === "MATCH_POI" || type === "MATCH_BUSLINE") return { reward: "3 Karten ziehen, 1 behalten", time: "3 min" };
    if (type === "MEASURE") return { reward: "3 Karten ziehen, 1 behalten", time: "3 min" };
    return { reward: "", time: "" };
  }
  const { reward, time } = rewardFor(decoded.type);
  if (decoded.type === "RADAR") {
    const radiusKm = Number(decoded.payload.radiusKm);
    const meters = Math.round(radiusKm * 1000);
    const exact = Boolean(decoded.payload.exact);
    if (exact) {
      // 100 m / 250 m: hider's exact GPS position is evaluated, not the bus stop
      return {
        text: `Bist du im Umkreis von ${meters} Metern von uns?`,
        note: "⚠️ Verstecker: dein exakter GPS-Standort wird geprüft – nicht die gewählte Haltestelle.",
        reward,
        time,
        doubled: false,
      };
    }
    return {
      text: `Bist du im Umkreis von ${meters} Metern von uns?`,
      note: "Verstecker: deine gewählte Haltestelle wird geprüft.",
      reward,
      time,
      doubled: false,
    };
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
    const label = CITY.districtLevels.find((l) => l.id === level)?.label ?? level;
    return { text: `Bist du im gleichen ${label} wie wir?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_POI") {
    const poiType = decoded.payload.poiType as string;
    const name = decoded.payload.nearestName as string;
    const label = CITY.poiLayers.find((l) => l.id === poiType)?.label ?? poiType;
    return { text: `Ist unser/e nächste/r ${label} \u201e${name}\u201c auch dein/e nächste/r ${label}?`, reward, time, doubled: false };
  }
  if (decoded.type === "MATCH_BUSLINE") {
    const line = decoded.payload.lineName as string;
    return { text: `Ist unsere nächste Buslinie (Linie ${line}) auch deine nächste Buslinie?`, reward, time, doubled: false };
  }
  if (decoded.type === "MEASURE") {
    const mt = decoded.payload.measureType as MeasureType;
    const distKm = Number(decoded.payload.distKm);
    const meters = Math.round(distKm * 1000);
    const label = MEASURE_TYPES.find((m) => m.id === mt)?.label ?? mt;
    return { text: `Wir sind ${meters} Meter von einer/m ${label} entfernt. Bist du näher dran oder weiter entfernt von einer/m ${label} als wir?`, reward, time, doubled: false };
  }
  return { text: "Unbekannte Frage", reward: "", time: "", doubled: false };
}

function App() {
  // --- localStorage helpers ---
  function lsGet<T>(key: string, fallback: T, reviver?: (raw: unknown) => T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return reviver ? reviver(parsed) : (parsed as T);
    } catch { return fallback; }
  }
  function lsSet(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
  }
  function mapReviver(raw: unknown): Map<string, number> {
    if (Array.isArray(raw)) return new Map(raw as [string, number][]);
    return new Map();
  }

  const [role, setRole] = useState<Role>(() => lsGet<Role>("hs_role", "landing"));
  const [geojson, setGeojson] = useState<StadtteileCollection | null>(null);
  const [geojsonError, setGeojsonError] = useState<string>("");
  const [selectedStopId, setSelectedStopId] = useState<string>(() => lsGet("hs_hideout", ""));

  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [previewStopId, setPreviewStopId] = useState<string | null>(null);
  const [mapClickPopup, setMapClickPopup] = useState<MapClickPopup | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [cursesOpen, setCursesOpen] = useState(false);
  const [selectedCurse, setSelectedCurse] = useState<number | null>(null);

  const [hiderInputCode, setHiderInputCode] = useState("");
  const [hiderFeedback, setHiderFeedback] = useState("");
  const [hiderAnswerCode, setHiderAnswerCode] = useState("");
  const [questionPreview, setQuestionPreview] = useState<QuestionPreview | null>(null);
  const [hiderUsedSubKeys, setHiderUsedSubKeys] = useState<Map<string, number>>(() => lsGet("hs_hiderUsed", new Map<string, number>(), mapReviver));
  const [hiderOverviewOpen, setHiderOverviewOpen] = useState(false);
  const [hiderFotoConfirm, setHiderFotoConfirm] = useState<{ id: string; label: string; description: string } | null>(null);

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
  const matchLevel: MatchLevel = CITY.districtLevels[0].id;
  const selectedPoiType = CITY.poiLayers[0]?.id ?? "";
  const [selectedBusLine, setSelectedBusLine] = useState<string>("");
  const selectedMeasureType: MeasureType = MEASURE_TYPES[0]?.id ?? "";
  const [usedFotoQuestions, setUsedFotoQuestions] = useState<Record<string, number>>(() => lsGet("hs_usedFoto", {}));
  const [fotoConfirmQuestion, setFotoConfirmQuestion] = useState<string | null>(null);
  const [buslineConfirm, setBuslineConfirm] = useState<string | null>(null);
  const [questionCategoryOpen, setQuestionCategoryOpen] = useState<Record<string, boolean>>({
    radar: false,
    thermo: false,
    matching: false,
    measuring: false,
    foto: false,
  });

  const [askedCodes, setAskedCodes] = useState<Record<string, QuestionCode>>(() => lsGet("hs_askedCodes", {}));
  const [latestQuestionCode, setLatestQuestionCode] = useState(() => lsGet("hs_latestCode", ""));
  const questionCodeRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (latestQuestionCode) {
      questionCodeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [latestQuestionCode]);
  const [answerInput, setAnswerInput] = useState("");
  const [answerFeedback, setAnswerFeedback] = useState("");
  const [questionFeedback, setQuestionFeedback] = useState("");
  const [appliedAnswers, setAppliedAnswers] = useState<Record<string, AnswerCode>>(() => lsGet("hs_appliedAnswers", {}));

  const usedSubKeys = useMemo(
    () => {
      const counts = new Map<string, number>();
      for (const qid of Object.keys(appliedAnswers)) {
        if (!askedCodes[qid]) continue;
        const key = questionSubKey(askedCodes[qid].type, askedCodes[qid].payload);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    },
    [appliedAnswers, askedCodes],
  );

  const [poiData, setPoiData] = useState<Record<string, PoiCollection>>({});
  const [poiVisible, setPoiVisible] = useState<Record<string, boolean>>(() => Object.fromEntries(CITY.poiLayers.map((l) => [l.id, false])));
  const [poiMenuOpen, setPoiMenuOpen] = useState(false);
  const [busLines, setBusLines] = useState<BusLineCollection | null>(null);
  const [busLinesVisible, setBusLinesVisible] = useState(false);
  const [busLegendOpen, setBusLegendOpen] = useState(false);
  const [borderVisible, setBorderVisible] = useState<Record<string, boolean>>(
    () => Object.fromEntries(CITY.districtLevels.map((l) => [l.id, false])),
  );

  const { position: currentPos, accuracy, error: geolocationError } = useCurrentLocation();

  useEffect(() => {
    CITY.poiLayers.forEach((layer) => {
      fetch(`${import.meta.env.BASE_URL}${CITY.poiBasePath}${layer.file}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<PoiCollection>;
        })
        .then((data) => setPoiData((prev) => ({ ...prev, [layer.id]: data })))
        .catch(() => { /* silently skip unavailable layers */ });
    });

    fetch(`${import.meta.env.BASE_URL}${CITY.busLinesFile}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<BusLineCollection>;
      })
      .then((data) => setBusLines(data))
      .catch(() => { /* silently skip */ });
  }, []);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}${CITY.stadtteileFile}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((res) => {
        const collection = res as StadtteileCollection;
        setGeojson(collection);
      })
      .catch((err: Error) => {
        fetch(`./${CITY.stadtteileFile}`)
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

  // Persist game state
  useEffect(() => { lsSet("hs_hiderUsed", [...hiderUsedSubKeys.entries()]); }, [hiderUsedSubKeys]);
  useEffect(() => { lsSet("hs_usedFoto", usedFotoQuestions); }, [usedFotoQuestions]);
  useEffect(() => { lsSet("hs_askedCodes", askedCodes); }, [askedCodes]);
  useEffect(() => { lsSet("hs_latestCode", latestQuestionCode); }, [latestQuestionCode]);
  useEffect(() => { lsSet("hs_appliedAnswers", appliedAnswers); }, [appliedAnswers]);

  const selectedStop = useMemo(() => STOPS.find((stop) => stop.id === selectedStopId) || null, [selectedStopId]);
  const radarKm = useMemo(() => {
    if (radarPreset === "custom") {
      const parsed = parseLocaleNumber(radarCustomKmInput);
      if (!Number.isFinite(parsed)) return 0.2;
      return Math.max(0.05, parsed);
    }
    return Number(radarPreset);
  }, [radarCustomKmInput, radarPreset]);

  /* eslint-disable react-hooks/set-state-in-effect -- Thermometer state follows external geolocation updates. */
  useEffect(() => {
    if (!thermoTracking.active || !currentPos) return;
    const lastPos = thermoTracking.lastPos;
    if (!lastPos) return;

    const deltaKm = haversineKm(lastPos, currentPos);
    if (deltaKm < 0.005) return;

    const nextWalked = thermoTracking.walkedKm + deltaKm;
    if (nextWalked >= thermoTracking.targetKm) {
      setThermoEnd(currentPos);
      setThermoTracking((prev) => ({ ...prev, active: false, walkedKm: nextWalked, lastPos: currentPos }));
      const doneMsg = `Ziel erreicht: ${thermoTracking.targetKm.toFixed(2)} km gelaufen. Endpunkt wurde gesetzt.`;
      setQuestionFeedback(doneMsg);
      notifySeeker(doneMsg);
      return;
    }

    setThermoTracking((prev) => ({ ...prev, walkedKm: nextWalked, lastPos: currentPos }));
  }, [currentPos, thermoTracking]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const activeAnswers = useMemo(() => {
    const answers = Object.values(appliedAnswers);
    const codes = askedCodes;
    answers.sort((a, b) => {
      const qa = codes[a.qid];
      const qb = codes[b.qid];
      return (ANSWER_TYPE_COST[qa?.type ?? ""] ?? 99) - (ANSWER_TYPE_COST[qb?.type ?? ""] ?? 99);
    });
    return answers;
  }, [appliedAnswers, askedCodes]);

  const districtGroupsByLevel = useMemo(() => {
    const out = new Map<string, Map<string, DistrictShape>>();
    if (!geojson) return out;
    for (const level of CITY.districtLevels) {
      const groups = new Map<string, StadtteilFeature[]>();
      for (const feat of geojson.features) {
        const name = level.resolve(feat.properties);
        if (!name) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(feat);
      }
      const colors = assignDistrictColors(groups);
      const dissolved = new Map<string, DistrictShape>();
      for (const [name, feats] of groups) {
        dissolved.set(name, {
          rings: dissolveFeatures(feats),
          color: colors.get(name) ?? DISTRICT_COLORS[0],
        });
      }
      out.set(level.id, dissolved);
    }
    return out;
  }, [geojson]);

  const filteredStops = useMemo(() => {
    if (activeAnswers.length === 0) return STOPS;

    // For each stop, sample 17 points (center + 8 on 400m ring + 8 on 200m ring).
    // If ALL sample points are excluded, the stop is filtered out.
    const HIDE_RADIUS_KM = CITY.hideRadiusM / 1000;
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

  // Only the exact (100 m / 250 m) radars are drawn as a concrete area on the
  // seeker's map. JA → the hider is inside the circle; NEIN → not inside it.
  // Larger radars only prune bus stops and draw nothing.
  const radarAreas = useMemo(() => {
    const out: { center: [number, number]; radiusKm: number; inside: boolean }[] = [];
    for (const a of Object.values(appliedAnswers)) {
      const q = askedCodes[a.qid];
      if (!q || q.type !== "RADAR" || !q.payload.exact) continue;
      out.push({
        center: q.payload.center as [number, number],
        radiusKm: Number(q.payload.radiusKm),
        inside: Boolean(a.answer.inside),
      });
    }
    return out;
  }, [appliedAnswers, askedCodes]);

  type GenOpts = { level?: MatchLevel; poiType?: string; lineName?: string; measureType?: MeasureType };
  async function generateQuestion(type: QuestionType, opts?: GenOpts): Promise<void> {
    if (!currentPos) return;

    let payload: Record<string, unknown> = {};

    if (type === "RADAR") {
      payload = {
        center: [currentPos.lat, currentPos.lon],
        radiusKm: radarKm,
        // Only the 100 m and 250 m presets probe the hider's exact GPS position.
        exact: radarPreset === "0.1" || radarPreset === "0.25",
      };
    }

    if (type === "THERMO_PATH") {
      if (!thermoStart || !thermoEnd) {
        setQuestionFeedback("Bitte zuerst Start- und Endpunkt setzen.");
        return;
      }
      payload = {
        start: [thermoStart.lat, thermoStart.lon],
        end: [thermoEnd.lat, thermoEnd.lon],
        targetKm: thermoTracking.targetKm,
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
        setQuestionFeedback("POI-Daten noch nicht geladen.");
        return;
      }
      const nearest = findNearestPoi(currentPos, layerData.features);
      if (!nearest) {
        setQuestionFeedback("Keine POIs gefunden.");
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
        setQuestionFeedback("Bitte eine Buslinie auswählen.");
        return;
      }
      payload = {
        lineName,
        reference: [currentPos.lat, currentPos.lon],
      };
    }

    if (type === "MEASURE") {
      const mt = opts?.measureType ?? selectedMeasureType;
      let distKm: number | null = null;

      if (mt.startsWith("border_")) {
        distKm = distToNearestBorder(currentPos, geojson);
        if (!Number.isFinite(distKm)) { setQuestionFeedback("Grenzabstand konnte nicht berechnet werden."); return; }
      } else {
        // POI type
        const layerData = poiData[mt];
        if (!layerData) { setQuestionFeedback("POI-Daten noch nicht geladen."); return; }
        const nearest = findNearestPoi(currentPos, layerData.features);
        if (!nearest) { setQuestionFeedback("Keine POIs gefunden."); return; }
        distKm = nearest.dist;
      }

      if (distKm === null) { setQuestionFeedback("Abstand konnte nicht berechnet werden."); return; }
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
    setQuestionFeedback(`${renderType(type)}-Code erstellt.`);
  }

  function startThermometer(targetKm: number): void {
    if (!currentPos) {
      setQuestionFeedback("Aktueller Standort fehlt. Bitte GPS freigeben.");
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
    setQuestionFeedback(`Thermometer gestartet: laufe ${targetKm.toFixed(2)} km.`);
  }

  function resetThermometer(): void {
    setThermoStart(null);
    setThermoEnd(null);
    setThermoTracking((prev) => ({ ...prev, active: false, walkedKm: 0, lastPos: null }));
  }

  async function evaluateHiderCode(): Promise<void> {
    try {
      if (!selectedStop) {
        setHiderFeedback("Bitte zuerst eine Bushaltestelle auswählen.");
        return;
      }
      const decoded = decodeCode(hiderInputCode.trim());
      if (!("payload" in decoded)) {
        setHiderFeedback("Bitte einen Fragecode einfügen (RADAR_/THERMO_/MATCH_...).");
        return;
      }

      const realPos: Position = { lat: selectedStop.lat, lon: selectedStop.lon };
      let answer: Record<string, unknown> = {};
      let feedback = "";

      if (decoded.type === "RADAR") {
        const center = decoded.payload.center as [number, number];
        const radiusKm = Number(decoded.payload.radiusKm);
        // 100 m / 250 m: use the hider's exact GPS position, not the bus stop
        const useExactPos = Boolean(decoded.payload.exact);
        if (useExactPos && !currentPos) {
          setHiderFeedback("Für den 100 m / 250 m Radar wird dein exakter GPS-Standort benötigt. GPS nicht verfügbar.");
          return;
        }
        const posForRadar = useExactPos ? currentPos! : realPos;
        const inside = haversineKm(posForRadar, { lat: center[0], lon: center[1] }) <= radiusKm;
        answer = { inside };
        const posLabel = useExactPos ? "exakter GPS-Standort" : "gewählte Haltestelle";
        feedback = inside ? `Radar: JA, im Umkreis. (${posLabel})` : `Radar: NEIN, außerhalb. (${posLabel})`;
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
        const poiLabel = CITY.poiLayers.find((l) => l.id === poiType)?.label ?? poiType;
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

      if (decoded.type === "MEASURE") {
        const mt = decoded.payload.measureType as MeasureType;
        const seekerDist = Number(decoded.payload.distKm);
        let hiderDist: number | null = null;

        if (mt.startsWith("border_")) {
          hiderDist = distToNearestBorder(realPos, geojson);
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
      const subKey = questionSubKey(decoded.type, decoded.payload);
      setHiderUsedSubKeys((prev) => {
        const next = new Map(prev);
        next.set(subKey, (prev.get(subKey) ?? 0) + 1);
        return next;
      });
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
      setAnswerInput("");
      setAnswerFeedback("Antwort angewendet. Karte wurde gefiltert.");
    } catch (err) {
      setAnswerFeedback(`Antwort ungültig: ${(err as Error).message}`);
    }
  }

  const displayedStops = role === "seeker" ? filteredStops : STOPS;
  const clickableStops = role === "hider" && selectedStop ? [selectedStop] : displayedStops;
  const visibleDistrictLevel = CITY.districtLevels.find((lvl) => borderVisible[lvl.id])?.id ?? null;

  function isQuestionCategoryOpen(id: string): boolean {
    return questionCategoryOpen[id] ?? false;
  }

  function toggleQuestionCategory(id: string): void {
    setQuestionCategoryOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  }

  const mapLayerControls = (
    <>
      <div className="poi-menu">
        <button className="poi-menu-toggle" onClick={() => setPoiMenuOpen((v) => !v)}>
          <span className="poi-menu-arrow">{poiMenuOpen ? "▾" : "▸"}</span>
          POI-Ebenen
        </button>
        {poiMenuOpen && (
          <div className="poi-menu-list">
            {CITY.districtLevels.map((lvl, idx) => (
              <label key={lvl.id} className="poi-menu-item">
                <input
                  type="checkbox"
                  checked={borderVisible[lvl.id] ?? false}
                  onChange={() => setBorderVisible((prev) => ({ ...prev, [lvl.id]: !prev[lvl.id] }))}
                />
                <span className="poi-color-dot" style={{ background: BORDER_COLORS[idx % BORDER_COLORS.length] }} />
                {`${lvl.borderLabel}n`}
              </label>
            ))}
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
            {CITY.poiLayers.map((layer) => (
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
    </>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>{role === "hider" ? "Verstecker" : role === "seeker" ? "Sucher" : "Hide and Seek"}</h1>
        <div className="topbar-right">
          {role === "hider" && (
            <button
              className={`btn ghost${cursesOpen ? " active-btn" : ""}`}
              onClick={() => setCursesOpen((v) => !v)}
            >
              {cursesOpen ? "Zurück" : "Flüche 1-10"}
            </button>
          )}
          {!cursesOpen && role !== "landing" && (
            <button className="btn ghost" onClick={() => { setCursesOpen(false); setRole("landing"); }}>
              Zur Startseite
            </button>
          )}
        </div>
      </header>

      {cursesOpen && (
        <main className="curses-view">
          <h2>Flüche 1-10</h2>
          <p className="meta">Wähle eine Nummer, um den Fluch anzuzeigen.</p>
          <div className="curse-picker">
            {CURSES.map((_, i) => (
              <button
                key={i}
                className={`curse-num${selectedCurse === i ? " curse-num--active" : ""}`}
                onClick={() => setSelectedCurse(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
          {selectedCurse !== null && (
            <div className="curse-card">
              <h3 className="curse-card-title">{CURSES[selectedCurse].title}</h3>
              <p className="curse-card-desc">{CURSES[selectedCurse].description}</p>
              <p className="curse-card-cost"><strong>Kosten:</strong> {CURSES[selectedCurse].cost}</p>
            </div>
          )}
        </main>
      )}

      {!cursesOpen && role === "landing" && (
        <main className="landing">
          <h2>Stadt auswählen</h2>
          <div className="landing-actions">
            {Object.values(CITIES).map((c) => (
              <button
                key={c.id}
                className={`btn ${c.id === CITY.id ? "" : "ghost"}`}
                onClick={() => switchCity(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <h2 style={{ marginTop: 24 }}>Rolle auswählen</h2>
          <div className="landing-actions">
            <button className="btn" onClick={() => setRole("hider")}>
              Verstecker
            </button>
            <button className="btn secondary" onClick={() => setRole("seeker")}>
              Sucher
            </button>
          </div>
          <button
            className="btn ghost"
            style={{ marginTop: 24, fontSize: "0.82rem" }}
            onClick={() => setShowResetConfirm(true)}
          >
            Spiel zurücksetzen
          </button>

          {showResetConfirm && (
            <div className="question-preview-overlay" onClick={() => setShowResetConfirm(false)}>
              <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                <p className="question-preview-text">Bist du sicher, dass du das Spiel zurücksetzen möchtest? Alle Daten gehen verloren.</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" style={{ flex: 1, background: "#dc2626", borderColor: "#dc2626" }} onClick={() => {
                    const keys = ["hs_role", "hs_hideout", "hs_hiderUsed", "hs_usedFoto", "hs_askedCodes", "hs_latestCode", "hs_appliedAnswers"];
                    keys.forEach((k) => localStorage.removeItem(k));
                    setSelectedStopId("");
                    setHiderUsedSubKeys(new Map());
                    setUsedFotoQuestions({});
                    setAskedCodes({});
                    setLatestQuestionCode("");
                    setAppliedAnswers({});
                    setHiderInputCode("");
                    setHiderFeedback("");
                    setHiderAnswerCode("");
                    setAnswerInput("");
                    setAnswerFeedback("");
                    setQuestionFeedback("");
                    setShowResetConfirm(false);
                  }}>Ja, zurücksetzen</button>
                  <button className="btn ghost" style={{ flex: 1 }} onClick={() => setShowResetConfirm(false)}>Abbrechen</button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {!cursesOpen && (role === "hider" || role === "seeker") && (
        <main className="game-layout">
          <aside className="panel">
            {mapLayerControls}

            {role === "hider" && (
              <>
                <div className="row">
                  <label>Aktuelles Versteck</label>
                  <strong>{selectedStop?.name ?? "Noch nicht gewählt (Wählen durch Klicken in der Karte)"}</strong>
                </div>

                {hiderAnswerCode && (
                  <div className="card" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
                    <label style={{ color: "#166534", fontWeight: 700 }}>Letzter Antwortcode</label>
                    {hiderFeedback && <p className="meta" style={{ margin: "0 0 6px", color: "#166534" }}>{hiderFeedback}</p>}
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
                            const doubled = (hiderUsedSubKeys.get(subKey) ?? 0) >= 1;
                            setQuestionPreview({ ...preview, doubled });
                          }
                        } catch {
                          setQuestionPreview(null);
                        }
                      }}
                      placeholder={CITY.placeholder}
                    />
                </div>

                {questionPreview !== null && (
                  <div className="question-preview-overlay" onClick={() => setQuestionPreview(null)}>
                    <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                      <p className="question-preview-text">{questionPreview.text}</p>
                      {questionPreview.note && (
                        <p className="meta small" style={{ color: "#b45309", margin: "4px 0 0" }}>{questionPreview.note}</p>
                      )}
                      <div className="question-preview-meta">
                        <span>🎴 {questionPreview.doubled ? <><s>{questionPreview.reward}</s> <strong style={{color:"#16a34a"}}>{doubleReward(questionPreview.reward)}</strong> (2×)</> : questionPreview.reward}</span>
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

                <div className="poi-menu">
                  <button className="poi-menu-toggle" onClick={() => setHiderOverviewOpen((v) => !v)}>
                    <span className="poi-menu-arrow">{hiderOverviewOpen ? "▾" : "▸"}</span>
                    Fragenübersicht
                  </button>
                  {hiderOverviewOpen && (
                    <div className="hider-overview">
                      {QUESTION_CATEGORIES.map((cat) => {
                        return (
                        <div key={cat.group} className="hider-overview-group">
                          {/* Category header always shows the base reward. The doubled reward
                              applies per question — only when the exact same question is asked
                              again — and is surfaced in the question preview, not here. */}
                          <h4>{cat.group} <span className="hider-overview-reward">🎴 {cat.reward} · ⏱️ {cat.time}</span></h4>
                          <div className="q-grid">
                            {cat.items.map((item) => {
                              const count = hiderUsedSubKeys.get(item.subKey) ?? 0;
                              const cls = count >= 2 ? " q-btn--exhausted" : count >= 1 ? " q-btn--used" : "";
                              const isFoto = item.subKey.startsWith("FOTO_");
                              return (
                                <button
                                  key={item.subKey}
                                  className={`q-btn q-btn--overview${cls}`}
                                  onClick={isFoto ? () => {
                                    const fotoId = item.subKey.replace("FOTO_", "");
                                    const fq = FOTO_QUESTIONS.find((q) => q.id === fotoId);
                                    setHiderFotoConfirm(fq ?? null);
                                  } : () => {}}
                                  style={isFoto ? { cursor: "pointer" } : {}}
                                >
                                  <span className="q-btn-label">{item.label}</span>
                                  {count > 0 && <span className="q-btn-count">{count}×</span>}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {hiderFotoConfirm !== null && (
                  <div className="question-preview-overlay" onClick={() => setHiderFotoConfirm(null)}>
                    <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const subKey = `FOTO_${hiderFotoConfirm.id}`;
                        const count = hiderUsedSubKeys.get(subKey) ?? 0;
                        return (
                          <>
                            <p className="question-preview-text">Foto-Frage: <strong>{hiderFotoConfirm.label}</strong></p>
                            <p className="meta small" style={{ margin: "0 0 8px" }}>{hiderFotoConfirm.description}</p>
                            <div className="question-preview-meta">
                              <span>🎴 {count >= 1 ? <><s>1 Karte ziehen, 1 behalten</s> <strong style={{color:"#16a34a"}}>2 Karten ziehen, 2 behalten</strong> (2×)</> : "1 Karte ziehen, 1 behalten"}</span>
                              <span>⏱️ 10 min</span>
                            </div>
                            {count >= 1 && (
                              <p className="meta small" style={{ color: "#b45309", margin: 0 }}>⚠️ Diese Frage wurde bereits gestellt – doppelte Belohnung!</p>
                            )}
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                              <button className="btn" style={{ flex: 1 }} onClick={() => {
                                setHiderUsedSubKeys((prev) => {
                                  const next = new Map(prev);
                                  next.set(subKey, (prev.get(subKey) ?? 0) + 1);
                                  return next;
                                });
                                setHiderFotoConfirm(null);
                              }}>Als gestellt markieren</button>
                              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setHiderFotoConfirm(null)}>Schließen</button>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </>
            )}

            {role === "seeker" && (
              <>
                <div className="row" ref={questionCodeRowRef} style={{ marginTop: 12 }}>
                  <label>Fragecode erzeugen</label>
                  <textarea readOnly value={latestQuestionCode} />
                  <button className={latestQuestionCode ? "btn" : "btn ghost"} onClick={() => copyText(latestQuestionCode)}>
                    Rauskopieren
                  </button>
                  <p className="meta">{questionFeedback}</p>
                </div>

                <div className="row">
                  <label>Antwortcode eintragen</label>
                  <textarea value={answerInput} onChange={(e) => setAnswerInput(e.target.value)} placeholder="A_RADAR_1A2B_JA" />
                  <button className={answerInput ? "btn" : "btn ghost"} onClick={applyAnswerCode}>
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

                <CategoryCard
                  id="radar"
                  title="Radar"
                  meta="Belohnung: 2 Karten ziehen, 1 behalten · Zeitlimit: 3 min"
                  open={isQuestionCategoryOpen("radar")}
                  onToggle={() => toggleQuestionCategory("radar")}
                >
                  <label>Radius</label>
                  <div className="split-buttons">
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_0.1", usedSubKeys)} ${radarPreset === "0.1" ? "active-btn" : ""}`} onClick={() => setRadarPreset("0.1")}>100 m</button>
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_0.25", usedSubKeys)} ${radarPreset === "0.25" ? "active-btn" : ""}`} onClick={() => setRadarPreset("0.25")}>250 m</button>
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_0.5", usedSubKeys)} ${radarPreset === "0.5" ? "active-btn" : ""}`} onClick={() => setRadarPreset("0.5")}>500 m</button>
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_1", usedSubKeys)} ${radarPreset === "1" ? "active-btn" : ""}`} onClick={() => setRadarPreset("1")}>1 km</button>
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_2", usedSubKeys)} ${radarPreset === "2" ? "active-btn" : ""}`} onClick={() => setRadarPreset("2")}>2 km</button>
                    <button className={`btn ghost q-btn${qBtnCls("RADAR_custom", usedSubKeys)} ${radarPreset === "custom" ? "active-btn" : ""}`} onClick={() => setRadarPreset("custom")}>Custom</button>
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
                  {radarPreset === "0.1" || radarPreset === "0.25" ? (
                    <p className="meta small" style={{ color: "#b45309", marginTop: 4 }}>
                      ⚠️ 100 m / 250 m: Verstecker wertet seinen <strong>exakten GPS-Standort</strong> aus – nicht die gewählte Haltestelle. Der erlaubte Bereich wird auf der Karte eingezeichnet.
                    </p>
                  ) : (
                    <p className="meta small" style={{ marginTop: 4 }}>
                      Ab 500 m &amp; Custom: Es wird die <strong>gewählte Haltestelle</strong> des Versteckers geprüft; auf der Karte werden nur unmögliche Haltestellen ausgeblendet.
                    </p>
                  )}
                  <p className="meta small">Aktiv: {formatKmLocale(radarKm)} km</p>
                  <button className="q-btn" onClick={() => generateQuestion("RADAR")}>Radar-Code erzeugen</button>
                </CategoryCard>

                <CategoryCard
                  id="thermo"
                  title="Thermometer"
                  meta="Belohnung: 2 Karten ziehen, 1 behalten · Zeitlimit: 3 min"
                  open={isQuestionCategoryOpen("thermo")}
                  onToggle={() => toggleQuestionCategory("thermo")}
                >
                  <div className="split-buttons">
                    <button className={`btn ghost q-btn${qBtnCls("THERMO_PATH_0.75", usedSubKeys)}`} onClick={() => startThermometer(0.75)}>
                      Start 750 m
                    </button>
                    <button className={`btn ghost q-btn${qBtnCls("THERMO_PATH_1.5", usedSubKeys)}`} onClick={() => startThermometer(1.5)}>
                      Start 1,5 km
                    </button>
                  </div>
                  <p className="meta small">
                    Start: {thermoStart ? `${thermoStart.lat.toFixed(5)}, ${thermoStart.lon.toFixed(5)}` : "-"}
                    <br />
                    Ziel: {thermoEnd ? `${thermoEnd.lat.toFixed(5)}, ${thermoEnd.lon.toFixed(5)}` : "-"}
                    <br />
                    Status: {thermoTracking.active ? "Läuft" : "Inaktiv"}
                    {thermoTracking.active && (
                      <>
                        <br />
                        Gelaufen: {thermoTracking.walkedKm.toFixed(2)} / {thermoTracking.targetKm.toFixed(2)} km
                      </>
                    )}
                  </p>
                  <button className="btn ghost" onClick={resetThermometer}>Thermometer zurücksetzen</button>
                  <button className="q-btn" onClick={() => generateQuestion("THERMO_PATH")}>Thermometer-Code erzeugen</button>
                </CategoryCard>

                <CategoryCard
                  id="matching"
                  title="Matching"
                  meta="Belohnung: 3 Karten ziehen, 1 behalten · Zeitlimit: 3 min"
                  open={isQuestionCategoryOpen("matching")}
                  onToggle={() => toggleQuestionCategory("matching")}
                >
                  <div className="q-grid">
                    {CITY.districtLevels.map((lvl) => (
                      <button key={lvl.id} className={`q-btn${qBtnCls(`MATCH_DISTRICT_${lvl.id}`, usedSubKeys)}`} onClick={() => generateQuestion("MATCH_DISTRICT", { level: lvl.id })}>{lvl.label}</button>
                    ))}
                    {CITY.poiLayers.map((l) => (
                      <button key={l.id} className={`q-btn${qBtnCls(`MATCH_POI_${l.id}`, usedSubKeys)}`} onClick={() => generateQuestion("MATCH_POI", { poiType: l.id })}>{l.label}</button>
                    ))}
                  </div>
                  <div className="q-busline-row">
                    <select value={selectedBusLine} onChange={(e) => setSelectedBusLine(e.target.value)}>
                      <option value="">– Buslinie wählen –</option>
                      {busLines && busLines.features.map((f) => (
                        <option key={f.properties.route_id} value={f.properties.name}>Linie {f.properties.name}</option>
                      ))}
                    </select>
                    <button className={`q-btn${selectedBusLine ? qBtnCls(`MATCH_BUSLINE_${selectedBusLine}`, usedSubKeys) : ""}`} onClick={() => {
                      if (!selectedBusLine) { setQuestionFeedback("Bitte eine Buslinie auswählen."); return; }
                      setBuslineConfirm(selectedBusLine);
                    }}>Buslinie →</button>
                  </div>
                </CategoryCard>

                <CategoryCard
                  id="measuring"
                  title="Measuring"
                  meta="Belohnung: 3 Karten ziehen, 1 behalten · Zeitlimit: 3 min"
                  open={isQuestionCategoryOpen("measuring")}
                  onToggle={() => toggleQuestionCategory("measuring")}
                >
                  <div className="q-grid">
                    {MEASURE_TYPES.map((m) => (
                      <button key={m.id} className={`q-btn${qBtnCls(`MEASURE_${m.id}`, usedSubKeys)}`} onClick={() => generateQuestion("MEASURE", { measureType: m.id })}>{m.label}</button>
                    ))}
                  </div>
                </CategoryCard>

                <CategoryCard
                  id="foto"
                  title="Foto"
                  meta="Belohnung: 1 Karte ziehen, 1 behalten · Zeitlimit: 10 min"
                  open={isQuestionCategoryOpen("foto")}
                  onToggle={() => toggleQuestionCategory("foto")}
                >
                  <div className="q-grid">
                    {FOTO_QUESTIONS.map((q) => (
                      <button key={q.id} className={`q-btn${(usedFotoQuestions[q.id] ?? 0) >= 2 ? " q-btn--exhausted" : (usedFotoQuestions[q.id] ?? 0) >= 1 ? " q-btn--used" : ""}`} onClick={() => setFotoConfirmQuestion(q.id)}>{q.label}</button>
                    ))}
                  </div>
                </CategoryCard>

                {fotoConfirmQuestion !== null && (() => {
                  const fq = FOTO_QUESTIONS.find((q) => q.id === fotoConfirmQuestion);
                  const fotoCount = usedFotoQuestions[fotoConfirmQuestion] ?? 0;
                  return (
                    <div className="question-preview-overlay" onClick={() => setFotoConfirmQuestion(null)}>
                      <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                        <p className="question-preview-text">Foto-Frage stellen: <strong>{fq?.label}</strong>?</p>
                        {fq && <p className="meta small" style={{ margin: "0 0 8px" }}>{fq.description}</p>}
                        <div className="question-preview-meta">
                          <span>🎴 {fotoCount >= 1 ? <><s>1 Karte ziehen, 1 behalten</s> <strong style={{color:"#16a34a"}}>2 Karten ziehen, 2 behalten</strong> (2×)</> : "1 Karte ziehen, 1 behalten"}</span>
                          <span>⏱️ 10 min</span>
                        </div>
                        {fotoCount >= 1 && (
                          <p className="meta small" style={{ color: "#b45309", margin: 0 }}>⚠️ Diese Frage wurde bereits gestellt – doppelte Belohnung!</p>
                        )}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="btn" style={{ flex: 1 }} onClick={() => {
                            setUsedFotoQuestions((prev) => ({ ...prev, [fotoConfirmQuestion]: (prev[fotoConfirmQuestion] ?? 0) + 1 }));
                            setFotoConfirmQuestion(null);
                          }}>Ja, stellen</button>
                          <button className="btn ghost" style={{ flex: 1 }} onClick={() => setFotoConfirmQuestion(null)}>Abbrechen</button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {buslineConfirm !== null && (
                  <div className="question-preview-overlay" onClick={() => setBuslineConfirm(null)}>
                    <div className="question-preview-box" onClick={(e) => e.stopPropagation()}>
                      <p className="question-preview-text">Buslinien-Frage stellen: <strong>Linie {buslineConfirm}</strong>?</p>
                      <p className="meta small" style={{ margin: "0 0 8px", color: "#b45309" }}>
                        ⚠️ Hinweis: Diese Frage darfst du nur stellen, wenn ihr euch gerade in einem Bus oder einer Straßenbahn der Linie {buslineConfirm} befindet.
                      </p>
                      <div className="question-preview-meta">
                        <span>🎴 3 Karten ziehen, 1 behalten</span>
                        <span>⏱️ 3 min</span>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn" style={{ flex: 1 }} onClick={() => {
                          const line = buslineConfirm;
                          setBuslineConfirm(null);
                          generateQuestion("MATCH_BUSLINE", { lineName: line });
                        }}>Ja, stellen</button>
                        <button className="btn ghost" style={{ flex: 1 }} onClick={() => setBuslineConfirm(null)}>Abbrechen</button>
                      </div>
                    </div>
                  </div>
                )}

              </>
            )}

            {(geolocationError || geojsonError) && (
              <div className="warn">
                {geolocationError && <div>Standort: {geolocationError}</div>}
                {geojsonError && <div>GeoJSON: {geojsonError}</div>}
              </div>
            )}

          </aside>

          <section className="map-wrap">
            <MapContainer center={[CITY.center.lat, CITY.center.lon]} zoom={13} scrollWheelZoom className="map">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              />

              <RecenterOnPosition position={currentPos} />
              <CenterButton position={currentPos} />
              <ScaleControl position="bottomleft" imperial={false} />
              <MapClickResolver
                stops={clickableStops}
                geojson={geojson}
                districtLevel={visibleDistrictLevel}
                onStop={(stopId) => {
                  setPreviewStopId(stopId);
                  setMapClickPopup({ type: "stop", stopId });
                }}
                onDistrict={(name, position) => {
                  setPreviewStopId(null);
                  setMapClickPopup({ type: "district", name, position });
                }}
              />

              {(() => {
                // Hider: show only selected stop with permanent radius
                if (role === "hider" && selectedStop) {
                  return (
                    <>
                      <Circle
                        center={[selectedStop.lat, selectedStop.lon]}
                        radius={CITY.hideRadiusM}
                        pathOptions={{ color: "#0f172a", weight: 1.5, fillColor: "#94a3b8", fillOpacity: 0.15 }}
                        interactive={false}
                      />
                      <CircleMarker
                        center={[selectedStop.lat, selectedStop.lon]}
                        radius={8}
                        pathOptions={{ color: "#0f172a", weight: 2.4, fillColor: "#dc2626", fillOpacity: 0.9 }}
                        eventHandlers={{ click: () => setMapClickPopup(null) }}
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
                const previewStop = previewStopId ? STOPS.find((s) => s.id === previewStopId) ?? null : null;
                return (
                  <>
                    {previewStop && (
                      <Pane name="radiusPreview" style={{ zIndex: 350 }}>
                        <Circle
                          center={[previewStop.lat, previewStop.lon]}
                          radius={CITY.hideRadiusM}
                          pathOptions={{ color: "#0f172a", weight: 1.5, fillColor: "#94a3b8", fillOpacity: 0.15 }}
                          interactive={false}
                        />
                      </Pane>
                    )}
                    <ClusteredStops
                      stops={stopsToShow}
                      handlers={{
                        role,
                        onStopClick: () => setMapClickPopup(null),
                        onPopupOpen: (id) => setPreviewStopId(id),
                        onPopupClose: () => setPreviewStopId(null),
                        onSelectHideout: (id) => setConfirmStopId(id),
                      }}
                    />
                  </>
                );
              })()}

              {role === "seeker" && radarAreas.length > 0 && (
                <Pane name="radarAreas" style={{ zIndex: 330 }}>
                  {radarAreas.map((r, i) => (
                    <Circle
                      key={`radar-${i}`}
                      center={[r.center[0], r.center[1]]}
                      radius={r.radiusKm * 1000}
                      pathOptions={
                        r.inside
                          ? { color: "#1d4ed8", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.18 }
                          : { color: "#b91c1c", weight: 2, dashArray: "6 6", fillColor: "#ef4444", fillOpacity: 0.12 }
                      }
                      interactive={false}
                    />
                  ))}
                </Pane>
              )}

              <Pane name="districtBorders" style={{ zIndex: 320 }}>
                {CITY.districtLevels.map((lvl) =>
                  borderVisible[lvl.id]
                    ? [...(districtGroupsByLevel.get(lvl.id)?.entries() ?? [])].flatMap(([name, shape]) => {
                        const color = shape.color;
                        return shape.rings.map((ring, ri) => (
                          <Polygon
                            key={`${lvl.id}-${name}-${ri}`}
                            positions={ring.map(([lon, lat]) => [lat, lon] as [number, number])}
                            pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: 0.08 }}
                            interactive={false}
                          />
                        ));
                      })
                    : null,
                )}
              </Pane>

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

              {CITY.poiLayers.map((layer) =>
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

              {mapClickPopup?.type === "stop" && (() => {
                const stop = STOPS.find((s) => s.id === mapClickPopup.stopId);
                if (!stop) return null;
                return (
                  <Popup
                    position={[stop.lat, stop.lon]}
                    eventHandlers={{
                      remove: () => setMapClickPopup((prev) => (prev?.type === "stop" && prev.stopId === stop.id ? null : prev)),
                    }}
                  >
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
                );
              })()}

              {mapClickPopup?.type === "district" && (() => {
                const popup = mapClickPopup;
                return (
                  <Popup
                    position={[popup.position.lat, popup.position.lon]}
                    eventHandlers={{
                      remove: () =>
                        setMapClickPopup((prev) =>
                          prev?.type === "district" && prev.name === popup.name ? null : prev,
                        ),
                    }}
                  >
                    <b>{popup.name}</b>
                  </Popup>
                );
              })()}
            </MapContainer>
          </section>
        </main>
      )}

    </div>
  );
}

export default App;
