import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { STOPS } from "./data/stops";

type Role = "landing" | "hider" | "seeker";
type QuestionType = "RADAR" | "THERMO_PATH" | "MATCH_DISTRICT";
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
  "62": "Kinderhaus",
  "63": "Kinderhaus",
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
  const level = payload.payload.level as MatchLevel;
  const ref = payload.payload.reference as [number, number];
  return `MATCH_${payload.qid}_${level === "bezirk" ? "B" : "S"}_${formatCoord(ref[0])};${formatCoord(ref[1])}`;
}

function encodeAnswerCode(payload: AnswerCode): string {
  if (payload.type === "RADAR") {
    return `A_RADAR_${payload.qid}_${payload.answer.inside ? "JA" : "NEIN"}`;
  }
  if (payload.type === "THERMO_PATH") {
    return `A_THERMO_${payload.qid}_${String(payload.answer.trend)}`;
  }
  return `A_MATCH_${payload.qid}_${payload.answer.match ? "JA" : "NEIN"}`;
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

  throw new Error("Unbekanntes Code-Format");
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
    const value = feature.properties.STADTBEZIR ?? null;
    return value ? value.trim() : null;
  }
  return bezirkForFeature(feature);
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
  return "Matching Frage";
}

function App() {
  const [role, setRole] = useState<Role>(() => (localStorage.getItem("hs_role") as Role) || "landing");
  const [geojson, setGeojson] = useState<StadtteileCollection | null>(null);
  const [geojsonError, setGeojsonError] = useState<string>("");
  const [selectedStopId, setSelectedStopId] = useState<string>(() => localStorage.getItem("hs_hideout") || "");

  const [hiderInputCode, setHiderInputCode] = useState("");
  const [hiderFeedback, setHiderFeedback] = useState("");
  const [hiderAnswerCode, setHiderAnswerCode] = useState("");

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
  const [matchLevel, setMatchLevel] = useState<MatchLevel>("bezirk");
  const [askedCodes, setAskedCodes] = useState<Record<string, QuestionCode>>({});
  const [latestQuestionCode, setLatestQuestionCode] = useState("");
  const [answerInput, setAnswerInput] = useState("");
  const [answerFeedback, setAnswerFeedback] = useState("");
  const [appliedAnswers, setAppliedAnswers] = useState<Record<string, AnswerCode>>({});

  const { position: currentPos, accuracy, error: geolocationError } = useCurrentLocation();

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

  const filteredStops = useMemo(() => {
    const active = Object.values(appliedAnswers);
    if (active.length === 0) return STOPS;

    return STOPS.filter((stop) => {
      return active.every((answerCode) => {
        const question = askedCodes[answerCode.qid];
        if (!question) return true;

        if (question.type === "RADAR") {
          const center = question.payload.center as [number, number];
          const radiusKm = Number(question.payload.radiusKm);
          const inside = Boolean(answerCode.answer.inside);
          const isInside = haversineKm({ lat: stop.lat, lon: stop.lon }, { lat: center[0], lon: center[1] }) <= radiusKm;
          return inside ? isInside : !isInside;
        }

        if (question.type === "THERMO_PATH") {
          const start = question.payload.start as [number, number];
          const end = question.payload.end as [number, number];
          const d1 = haversineKm({ lat: stop.lat, lon: stop.lon }, { lat: start[0], lon: start[1] });
          const d2 = haversineKm({ lat: stop.lat, lon: stop.lon }, { lat: end[0], lon: end[1] });
          let trend: "WARMER" | "COLDER" | "SAME" = "SAME";
          if (d2 < d1 - 0.02) trend = "WARMER";
          else if (d2 > d1 + 0.02) trend = "COLDER";
          return trend === answerCode.answer.trend;
        }

        const level = question.payload.level as MatchLevel;
        const refPoint = question.payload.reference as [number, number];
        const stopValue = findDistrictLabel({ lat: stop.lat, lon: stop.lon }, geojson, level);
        const refValue = findDistrictLabel({ lat: refPoint[0], lon: refPoint[1] }, geojson, level);
        if (!stopValue || !refValue) return false;
        const match = stopValue === refValue;
        return match === Boolean(answerCode.answer.match);
      });
    });
  }, [appliedAnswers, askedCodes, geojson]);

  function generateQuestion(type: QuestionType): void {
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
        level: matchLevel,
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

  function evaluateHiderCode(): void {
    try {
      if (!selectedStop) {
        setHiderFeedback("Bitte zuerst eine Haltestelle als Versteck wählen.");
        return;
      }
      const decoded = decodeCode(hiderInputCode.trim());
      if (!("payload" in decoded)) {
        setHiderFeedback("Bitte einen Fragecode einfügen (RADAR_/THERMO_/MATCH_...).");
        return;
      }

      const hideout = { lat: selectedStop.lat, lon: selectedStop.lon };
      let answer: Record<string, unknown> = {};
      let feedback = "";

      if (decoded.type === "RADAR") {
        const center = decoded.payload.center as [number, number];
        const radiusKm = Number(decoded.payload.radiusKm);
        const inside = haversineKm(hideout, { lat: center[0], lon: center[1] }) <= radiusKm;
        answer = { inside };
        feedback = inside ? "Radar: JA, im Umkreis." : "Radar: NEIN, außerhalb.";
      }

      if (decoded.type === "THERMO_PATH") {
        const start = decoded.payload.start as [number, number];
        const end = decoded.payload.end as [number, number];
        const d1 = haversineKm(hideout, { lat: start[0], lon: start[1] });
        const d2 = haversineKm(hideout, { lat: end[0], lon: end[1] });
        let trend: "WARMER" | "COLDER" | "SAME" = "SAME";
        if (d2 < d1 - 0.02) trend = "WARMER";
        else if (d2 > d1 + 0.02) trend = "COLDER";
        answer = { trend };
        feedback = `Thermometer: ${trend}`;
      }

      if (decoded.type === "MATCH_DISTRICT") {
        const level = decoded.payload.level as MatchLevel;
        const reference = decoded.payload.reference as [number, number];
        const hideoutLabel = findDistrictLabel(hideout, geojson, level);
        const refLabel = findDistrictLabel({ lat: reference[0], lon: reference[1] }, geojson, level);
        const match = Boolean(hideoutLabel && refLabel && hideoutLabel === refLabel);
        answer = { match };
        feedback = match ? "Matching: JA" : "Matching: NEIN";
      }

      const answerCode: AnswerCode = {
        qid: decoded.qid,
        type: decoded.type,
        answer,
      };

      setHiderFeedback(feedback);
      setHiderAnswerCode(encodeAnswerCode(answerCode));
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
        <h1>Hide and Seek Munster</h1>
        <div className="topbar-right">
          {role !== "landing" && (
            <button className="btn ghost" onClick={() => setRole("landing")}>
              Zur Landing Page
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

                <div className="row">
                  <label>Fragecode vom Sucher</label>
                    <textarea
                      value={hiderInputCode}
                      onChange={(e) => setHiderInputCode(e.target.value)}
                      placeholder="RADAR_1A2B_51.96070;7.62610;2km"
                    />
                </div>
                <button className="btn" onClick={evaluateHiderCode}>
                  Code auswerten
                </button>
                <p className="meta">{hiderFeedback}</p>

                <div className="row">
                  <label>Antwortcode fur WhatsApp</label>
                  <textarea readOnly value={hiderAnswerCode} placeholder="A_RADAR_1A2B_JA" />
                  <button className="btn ghost" onClick={() => copyText(hiderAnswerCode)}>
                    Rauskopieren
                  </button>
                </div>
              </>
            )}

            {role === "seeker" && (
              <>
                <h2>Sucher</h2>
                <p className="meta">Erzeuge Fragen, sende den Code und trage die Antwort wieder ein.</p>

                <div className="card">
                  <h3>Radar</h3>
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
                  <button className="btn" onClick={() => generateQuestion("RADAR")}>Radar-Code erzeugen</button>
                </div>

                <div className="card">
                  <h3>Thermometer</h3>
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
                  <button className="btn" onClick={() => generateQuestion("THERMO_PATH")}>Thermometer-Code erzeugen</button>
                </div>

                <div className="card">
                  <h3>Matching Frage</h3>
                  <select value={matchLevel} onChange={(e) => setMatchLevel(e.target.value as MatchLevel)}>
                    <option value="bezirk">Gleicher Bezirk?</option>
                    <option value="stadtbezirk">Gleicher Stadtbezirk?</option>
                  </select>
                  <button className="btn" onClick={() => generateQuestion("MATCH_DISTRICT")}>
                    Matching-Code erzeugen
                  </button>
                </div>

                <div className="row">
                  <label>Zuletzt erzeugter Fragecode</label>
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
          </aside>

          <section className="map-wrap">
            <MapContainer center={[MUNSTER_CENTER.lat, MUNSTER_CENTER.lon]} zoom={13} scrollWheelZoom className="map">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              />

              <RecenterOnPosition position={currentPos} />
              <CenterButton position={currentPos} />

              {displayedStops.map((stop) => {
                const selected = stop.id === selectedStopId;
                const seekerOut = role === "seeker" && !filteredStops.some((item) => item.id === stop.id);

                return (
                  <CircleMarker
                    key={stop.id}
                    center={[stop.lat, stop.lon]}
                    radius={selected ? 8 : 6}
                    pathOptions={{
                      color: selected ? "#0f172a" : "#7f1d1d",
                      weight: selected ? 2.4 : 1.4,
                      fillColor: seekerOut ? "#cbd5e1" : selected ? "#f59e0b" : "#dc2626",
                      fillOpacity: seekerOut ? 0.25 : 0.9,
                    }}
                    eventHandlers={
                      role === "hider"
                        ? {
                            click: () => setSelectedStopId(stop.id),
                          }
                        : undefined
                    }
                  >
                    <Popup>
                      <b>{stop.name}</b>
                      <br />
                      {stop.count} Steig(e)
                    </Popup>
                  </CircleMarker>
                );
              })}

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
