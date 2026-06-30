# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A German-language web app for playing a *Jet Lag: The Game*–style "Hide and Seek" match in **Münster, Germany**. One player is the **Verstecker** (Hider), the other the **Sucher** (Seeker). The two phones are never connected — the entire game loop runs through **text codes copy-pasted between devices** (see "The code protocol" below). The UI language is German throughout (some headings deliberately use ASCII spellings like `auswaehlen`/`zuruecksetzen`).

The deployable app lives entirely in **`app/`**. The repository root holds the data-preparation pipeline (Python scripts + source GIS data) that generates the app's committed data files.

## Commands

All app commands run from `app/`:

```bash
cd app
npm install
npm run dev        # Vite dev server
npm run build      # tsc -b && vite build  (type-check THEN bundle; build fails on type errors)
npm run lint       # eslint .
npm run preview    # serve the production build

# E2E tests (Playwright). There is no npm "test" script — call playwright directly.
npx playwright test                          # webServer auto-runs `build && preview` on :4173
npx playwright test -g "evaluating RADAR"    # single test by title
npx playwright test e2e/app.spec.ts:273      # single test by file:line
```

Notes:
- `playwright.config.ts` builds and serves the app itself via `webServer` (`reuseExistingServer: true`), so you don't need a server running first. Tests navigate to base path `/Hide-and-Seek/`.
- Tests `localStorage.setItem` values **JSON-stringified**, because the app reads them through `lsGet` → `JSON.parse`. Mirror that when writing new tests.

## App architecture

The app is **one giant component file: `app/src/App.tsx`** (~2200 lines). React 18 + TypeScript + Vite + `react-leaflet`/Leaflet. There is no router, no state library, no component split — everything (types, geometry math, the code codec, all UI) lives in `App.tsx`. `app/src/data/stops.ts` is the only other source module.

Three roles drive the whole UI via one `role` state: `"landing" | "hider" | "seeker"`.

### The code protocol (the core mechanic)

Seeker and Hider exchange plain-text strings:

1. **Seeker** picks a question type, and `generateQuestion()` builds a `QuestionCode` from the seeker's current GPS position. `encodeQuestionCode()` serializes it, e.g. `RADAR_1A2B_51.96070;7.62610;2km` or `MEAS_MN34_kitas_0,5_51.96250;7.62830`. The `qid` is a random 4-char id.
2. **Hider** pastes the code. `decodeCode()` parses it (one regex per type), `evaluateHiderCode()` answers it **against the hider's chosen bus stop** (`selectedStop`), and `encodeAnswerCode()` emits an `AnswerCode` like `A_RADAR_1A2B_JA`.
3. **Seeker** pastes the answer back; `applyAnswerCode()` stores it, and the map re-filters.

`encodeQuestionCode` / `encodeAnswerCode` / `decodeCode` at the top of `App.tsx` are the single source of truth for the wire format — **the encode and decode sides must stay in lockstep**, and the Playwright tests assert exact code strings, so changing a format means updating both functions and the tests. Note German decimal commas appear in some numeric fields (`parseLocaleNumber` / `formatKmLocale` handle `,`↔`.`).

**Question types** (`QuestionType`): `RADAR`, `THERMO_PATH`, `MATCH_DISTRICT`, `MATCH_POI`, `MATCH_BUSLINE`, `MATCH_STREET`, `MEASURE`. "Foto" questions are manual-only (tracked for reward doubling; they produce no code).

**Special rule:** RADAR with radius ≤ 0.5 km evaluates the hider's **exact live GPS**, not the chosen bus stop (enforced in `evaluateHiderCode` and covered by e2e). Larger radii use the bus stop.

### Deduction / filtering (the Seeker's map)

The point of applying answers is to eliminate bus stops where the hider cannot be:

- **`isPointExcludedByAnswer` / `isPointExcluded`** — given a lat/lon, decide whether the accumulated answers rule that point out. This is the heart of the deduction logic; every question type implements its exclusion test here.
- **`filteredStops`** — for each stop, samples 17 points (center + two rings inside the 400 m `HIDE_RADIUS_M`) and keeps the stop if **any** sample survives all answers.
- **`ExclusionOverlay`** — a custom `L.GridLayer` subclass that shades ruled-out territory by sampling pixels per map tile through `isPointExcluded` (coarser step when a `MEASURE` answer is active, for performance).

### Geo data (runtime `fetch` from `app/public/`)

Loaded lazily on mount; failures are swallowed so missing layers degrade gracefully:
- `stadtteile-muenster.geojson` — Münster statistical districts. `GROUP_MAP` (by `NR_STATIST`) collapses these into **Bezirk** groups; `STADTBEZIRK_MAP` (by `STADTBEZIR`) collapses them into larger **Stadtbezirk** groups. These two levels back `MATCH_DISTRICT` and the border `MEASURE` types.
- `pois/*.geojson` — POI layers, configured in the `POI_LAYERS` array (each has its own `nameKey` for the GeoJSON property holding the name).
- `pois/buslinien.geojson` — bus routes as LineStrings (for `MATCH_BUSLINE` and the map overlay).

Key geometry helpers in `App.tsx`: `haversineKm`, `pointInRing`/`pointInGeometry` (ray casting), `distToSegment`, `distToNearestBorder`, `findNearestPoi`, `findNearestBusLines`, and **`dissolveFeatures`** (merges adjacent district polygons by canceling shared directed edges — used to draw clean Bezirk/Stadtbezirk outlines). `MATCH_STREET` uses a live Nominatim reverse-geocode (`reverseGeocodeStreet`).

### Persistence

All game state is mirrored to `localStorage` under `hs_`-prefixed keys (`hs_role`, `hs_hideout`, `hs_askedCodes`, `hs_appliedAnswers`, `hs_hiderUsed`, `hs_usedFoto`, `hs_latestCode`) via the `lsGet`/`lsSet` helpers. "Spiel zuruecksetzen" removes all of them. GPS comes from `useCurrentLocation` (a `watchPosition` wrapper).

## Deployment

GitHub Pages via `.github/workflows/deploy.yml` on push to `main` (builds `app/`, publishes `app/dist`). `vite.config.ts` sets `base: '/Hide-and-Seek/'` — this **must match the repo name**, and the e2e `BASE` constant depends on it.

## Data pipeline (Python, run from repo root)

`scripts/` regenerates the committed data; you only touch these when refreshing stops or bus lines. The GIS source folders `buslinien/` (GTFS) and `pois/` at the root are **gitignored** — the committed outputs live in `app/public/` and `app/src/data/stops.ts`.

- `generate_hardcoded_stops.py` — fetches Münster bus stops from the Overpass API → `busstops-hardcoded.js`.
- `restore_busline_stops.py` — re-adds Overpass stops within 150 m of a bus line and rewrites **`app/src/data/stops.ts`** (the `STOPS` array consumed by the app).
- `build_buslines_geojson.py` — converts GTFS feed in `buslinien/` → `app/public/pois/buslinien.geojson` (one LineString per route, skips E/N lines).
- `apply_removed_stops.py`, `move_kriegerweg_east.py` — one-off stop adjustments.
