import { test, expect, Page, Browser, BrowserContext } from "@playwright/test";

// ── Erfurt full-game simulations ──────────────────────────────
//
// Each test simulates a complete match with TWO independent browser contexts
// acting as the two phones (Verstecker + Sucher). GPS is faked per context
// and moved between questions; every code travels hider <-> seeker exactly
// like in a real match (copy question code -> evaluate -> copy answer code
// -> apply).
//
// The expected answers AND the expected "Haltestellen verbleiben" counts were
// computed independently from the committed Erfurt data (stops.erfurt.ts +
// public/erfurt/*.geojson) with a standalone port of the App.tsx geometry.
// A count mismatch means either the deduction logic or the data changed —
// if the Erfurt data files are regenerated, these numbers must be re-derived.

const URL = "http://localhost:4173/Hide-and-Seek/";
const PH = "RADAR_1A2B_50.97870;11.03280;2km"; // Erfurt hider placeholder

test.setTimeout(300_000);

const STOP = {
  anger: { id: "anger", name: "Anger", lat: 50.976386, lon: 11.034369 },
  gispersleben: { id: "gispersleben", name: "Gispersleben", lat: 51.022644, lon: 10.993464 },
  melchendorf: { id: "melchendorf", name: "Melchendorf", lat: 50.951963, lon: 11.075119 },
  urbich: { id: "urbicher kreuz", name: "Urbicher Kreuz", lat: 50.950239, lon: 11.093171 },
};

type Phone = { ctx: BrowserContext; page: Page; setGps: (lat: number, lon: number) => Promise<void> };

// The desktop grid gives .game-layout only a min-height, so a long panel
// (seeker) stretches the row and the map grows far beyond the viewport.
// A tall seeker viewport keeps the Leaflet view centre (= element centre)
// on screen for map clicks and puts the filtered stops into screenshots.
async function newPhone(browser: Browser, lat: number, lon: number, height = 900): Promise<Phone> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height },
    geolocation: { latitude: lat, longitude: lon },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  return {
    ctx,
    page,
    setGps: async (la: number, lo: number) => {
      await ctx.setGeolocation({ latitude: la, longitude: lo });
      await page.waitForTimeout(600); // let watchPosition deliver the new fix
    },
  };
}

async function bootErfurt(page: Page, init: { role?: "hider" | "seeker"; hideout?: string } = {}) {
  await page.goto(URL);
  await page.evaluate((o) => {
    localStorage.clear();
    // hs_ values are read through lsGet -> JSON.parse, so store them JSON-stringified
    localStorage.setItem("hs_city", JSON.stringify("erfurt"));
    if (o.role) localStorage.setItem("hs_role", JSON.stringify(o.role));
    if (o.hideout) localStorage.setItem("hs_hideout", JSON.stringify(o.hideout));
  }, init);
  await page.goto(URL);
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: test.info().outputPath(name) });
}

// GPS updates reach React asynchronously, so a single click could still use
// the previous position. Regenerate until the code carries the coordinates
// the test just set — the pattern pins them, so a stale code never leaks.
async function genCode(seeker: Page, doGenerate: () => Promise<void>, pattern: RegExp): Promise<string> {
  let value = "";
  await expect
    .poll(async () => {
      try {
        await doGenerate();
      } catch {
        // transient render gap (React swaps the panel DOM) — retry the click
      }
      value = await seeker.locator("textarea[readonly]").first().inputValue();
      return value;
    }, { timeout: 30_000 })
    .toMatch(pattern);
  return value;
}

function qidOf(code: string): string {
  const m = code.match(/^[A-Z]+_([A-Z0-9]{4})_/);
  if (!m) throw new Error(`no qid in ${code}`);
  return m[1];
}

async function hiderAnswer(
  hider: Page,
  code: string,
  expectedAnswer: string,
  beforeEvaluate?: () => Promise<void>,
): Promise<void> {
  await hider.getByPlaceholder(PH).fill(code);
  await expect(hider.locator(".question-preview-overlay")).toBeVisible();
  if (beforeEvaluate) await beforeEvaluate();
  await hider.getByRole("button", { name: "Code auswerten" }).click();
  // on success the overlay closes itself and the answer lands in the panel card
  await expect(hider.locator(".card textarea[readonly]")).toHaveValue(expectedAnswer, { timeout: 15_000 });
}

async function applyAnswer(seeker: Page, answer: string, active: number, remaining: number) {
  await seeker.getByPlaceholder("A_RADAR_1A2B_JA").fill(answer);
  await seeker.getByRole("button", { name: "Antwort anwenden" }).click();
  await expect(
    seeker.getByText(`${active} Antworten aktiv · ${remaining} Haltestellen verbleiben`),
  ).toBeVisible({ timeout: 30_000 });
}

async function playRound(opts: {
  seeker: Page;
  hider: Page;
  generate: () => Promise<void>;
  codePattern: RegExp;
  answerFor: (qid: string) => string;
  active: number;
  remaining: number;
  beforeEvaluate?: () => Promise<void>;
}): Promise<string> {
  const code = await genCode(opts.seeker, opts.generate, opts.codePattern);
  const answer = opts.answerFor(qidOf(code));
  await hiderAnswer(opts.hider, code, answer, opts.beforeEvaluate);
  await applyAnswer(opts.seeker, answer, opts.active, opts.remaining);
  return code;
}

// ── question-generation actions (seeker UI) ───────────────────

const CLICK = { timeout: 5000 }; // short per-click timeout; genCode() retries

// Once a question's answer is applied, its button gains a ::after badge
// ("✓"/"✗") that becomes part of the ACCESSIBLE NAME ("KiKA-Figur ✓"), so
// role-based exact-name lookups stop matching. Select by textContent instead
// — pseudo-element content is not part of textContent.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const qBtn = (scope: ReturnType<Page["locator"]>, label: string) =>
  scope.locator(".q-btn").filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) });

function radar(seeker: Page, preset: "100 m" | "250 m" | "500 m" | "1 km" | "2 km" | "Custom", customKm?: string) {
  return async () => {
    const card = seeker.locator("[data-cat='radar']");
    await qBtn(card, preset).click(CLICK);
    if (customKm !== undefined) await card.getByPlaceholder("z. B. 0,2").fill(customKm, CLICK);
    await card.getByRole("button", { name: "Radar-Code erzeugen" }).click(CLICK);
  };
}

const matching = (seeker: Page, label: string) => () =>
  qBtn(seeker.locator("[data-cat='matching']"), label).click(CLICK);

const measuring = (seeker: Page, label: string) => () =>
  qBtn(seeker.locator("[data-cat='measuring']"), label).click(CLICK);

const busline = (seeker: Page, line: string) => async () => {
  await seeker.locator("[data-cat='matching'] select").selectOption(line, CLICK);
  await qBtn(seeker.locator("[data-cat='matching']"), "Buslinie →").click(CLICK);
  await seeker.getByRole("button", { name: "Ja, stellen" }).click(CLICK);
};

const thermoGenerate = (seeker: Page) => () =>
  seeker.locator("[data-cat='thermo']").getByRole("button", { name: "Thermometer-Code erzeugen" }).click(CLICK);

// Walk the seeker along `waypoints` until the thermometer target is reached.
async function walkThermo(seeker: Phone, start: [number, number], waypoints: [number, number][]) {
  await seeker.setGps(start[0], start[1]);
  const card = seeker.page.locator("[data-cat='thermo']");
  // retry Start until the displayed start point is the fresh GPS position
  await expect
    .poll(async () => {
      await qBtn(card, "Start 750 m").click(CLICK);
      return card.textContent();
    }, { timeout: 15_000 })
    .toContain(`Start: ${start[0].toFixed(5)}, ${start[1].toFixed(5)}`);
  for (const [la, lo] of waypoints) await seeker.setGps(la, lo);
  await expect(seeker.page.getByText(/Ziel erreicht/)).toBeVisible({ timeout: 15_000 });
  const end = waypoints[waypoints.length - 1];
  await expect(card).toContainText(`Ziel: ${end[0].toFixed(5)}, ${end[1].toFixed(5)}`);
}

// ── map interaction ───────────────────────────────────────────

// Pixel offset of a target point relative to the map center at zoom 15
// (what the "center on GPS" button uses).
function pxOffset(fromLat: number, fromLon: number, toLat: number, toLon: number): { dx: number; dy: number } {
  const res = (156543.03392 * Math.cos((fromLat * Math.PI) / 180)) / 2 ** 15; // metres per pixel
  const mNorth = (toLat - fromLat) * 111320;
  const mEast = (toLon - fromLon) * 111320 * Math.cos((fromLat * Math.PI) / 180);
  return { dx: mEast / res, dy: -mNorth / res };
}

// Center the map on the phone's GPS position, click on the stop and assert
// the popup shows its name. For the seeker this doubles as the proof that the
// stop is still displayed (clicks only resolve against the filtered stops).
async function assertStopPopup(phone: Phone, gps: [number, number], stop: { lat: number; lon: number; name: string }) {
  const page = phone.page;
  // Retried as a whole: right after a GPS move the centre button can still
  // hold the previous position for a moment and centres the map on the old
  // spot — where the filtered map has no stop to click.
  await expect(async () => {
    // The panel grows during the game and the map element follows (see
    // newPhone) — but Leaflet caches its size, so its view centre drifts off
    // the element centre. A resize event makes Leaflet re-read the size.
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(300);
    await page.locator(".map-center-btn").click();
    await page.waitForTimeout(800); // pan/zoom animation
    // The map element can be (much) taller than the viewport (see newPhone) —
    // scroll so its centre (= the Leaflet view centre) is actually on screen.
    await page.evaluate(() => {
      const el = document.querySelector(".map")!;
      const r = el.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2);
    });
    let { dx, dy } = pxOffset(gps[0], gps[1], stop.lat, stop.lon);
    // if the stop coincides with the GPS marker, click just beside it so the
    // map click handler (not the GPS marker) receives the click
    if (Math.hypot(dx, dy) < 12) dx += 15;
    const box = (await page.locator(".map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    await expect(page.locator(".leaflet-popup-content b")).toHaveText(stop.name, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
}

// ══════════════════════════════════════════════════════════════
// SIM A — Altstadt-Klassiker: hideout Anger, seeker sweeps the old town.
// Radar JA + NEIN, Ortsteil-Match JA, KiKA-Match NEIN then JA (doubled
// reward), border measure, exact 100 m radar endgame with drawn area.
// ══════════════════════════════════════════════════════════════

test("SIM A: Altstadt game at Anger (radar, match, measure, exact endgame)", async ({ browser }) => {
  const seekerP = await newPhone(browser, 50.9761, 11.0223, 1600);
  const hiderP = await newPhone(browser, 50.9769, 11.03437);
  const seeker = seekerP.page;
  const hider = hiderP.page;

  try {
    // Seeker phone: switch the city through the real landing UI.
    await seeker.goto(URL);
    await seeker.evaluate(() => localStorage.clear());
    await seeker.goto(URL);
    await expect(seeker.getByRole("heading", { name: "Stadt auswählen" })).toBeVisible();
    await seeker.getByRole("button", { name: "Erfurt", exact: true }).click();
    // switchCity persists hs_city and reloads; afterwards Erfurt is the active (non-ghost) city
    await expect(seeker.getByRole("button", { name: "Erfurt", exact: true })).not.toHaveClass(/ghost/, { timeout: 15_000 });
    await seeker.getByRole("button", { name: "Sucher", exact: true }).click();
    await expect(seeker.getByRole("heading", { name: "Sucher" })).toBeVisible();
    await expect(seeker.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });

    // Hider phone: Erfurt, hideout Anger.
    await bootErfurt(hider, { role: "hider", hideout: STOP.anger.id });
    await expect(hider.locator(".row", { hasText: "Aktuelles Versteck" })).toContainText("Anger");
    await expect(hider.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
    await shot(hider, "simA-01-hider-hideout.png");

    // A1: RADAR 2 km from Domplatz — Anger is 0.85 km away -> JA.
    await playRound({
      seeker, hider,
      generate: radar(seeker, "2 km"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.97610;11\.02230;2km$/,
      answerFor: (q) => `A_RADAR_${q}_JA`,
      active: 1, remaining: 75,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simA-02-after-radar2km.png");

    // A2: RADAR 500 m south of Hbf — Anger stop is 0.9 km away -> NEIN.
    await seekerP.setGps(50.9695, 11.041);
    await playRound({
      seeker, hider,
      generate: radar(seeker, "500 m"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.96950;11\.04100;0,5km$/,
      answerFor: (q) => `A_RADAR_${q}_NEIN`,
      active: 2, remaining: 74,
    });

    // A3: Ortsteil match from Fischmarkt — both in Altstadt -> JA.
    await seekerP.setGps(50.9781, 11.0286);
    await playRound({
      seeker, hider,
      generate: matching(seeker, "Ortsteil"),
      codePattern: /^MATCH_[A-Z0-9]{4}_O_50\.97810;11\.02860$/,
      answerFor: (q) => `A_MATCH_${q}_JA`,
      active: 3, remaining: 38,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simA-03-after-ortsteil-match.png");

    // A4: KiKA match from Fischmarkt — seeker nearest "Bernd das Brot",
    // hider nearest "Maus und Elefant" -> NEIN.
    await playRound({
      seeker, hider,
      generate: matching(seeker, "KiKA-Figur"),
      codePattern: /^MPOI_[A-Z0-9]{4}_kika_50\.97810;11\.02860_Bernd das Brot$/,
      answerFor: (q) => `A_MPOI_${q}_NEIN`,
      active: 4, remaining: 38,
    });

    // A5: KiKA match again, now from the Anger itself — same nearest figure
    // -> JA. Second ask of the same question => hider sees doubled reward.
    await seekerP.setGps(50.9764, 11.0344);
    await playRound({
      seeker, hider,
      generate: matching(seeker, "KiKA-Figur"),
      codePattern: /^MPOI_[A-Z0-9]{4}_kika_50\.97640;11\.03440_Maus und Elefant$/,
      answerFor: (q) => `A_MPOI_${q}_JA`,
      active: 5, remaining: 10,
      beforeEvaluate: async () => {
        await expect(hider.getByText(/doppelte Belohnung/)).toBeVisible();
        await shot(hider, "simA-04-hider-doubled-preview.png");
      },
    });
    // seeker side: KiKA question asked twice -> button shows as exhausted
    await expect(
      qBtn(seeker.locator("[data-cat='matching']"), "KiKA-Figur"),
    ).toHaveClass(/q-btn--exhausted/);
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simA-05-after-kika-ja.png");

    // A6: border measure at the Krämpfertor — seeker 0.03 km from the next
    // Ortsteil border, the Anger stop is 0.51 km away -> FURTHER.
    await seekerP.setGps(50.9801, 11.041);
    await playRound({
      seeker, hider,
      generate: measuring(seeker, "Ortsteilgrenze"),
      codePattern: /^MEAS_[A-Z0-9]{4}_border_ortsteil_0,03_50\.98010;11\.04100$/,
      answerFor: (q) => `A_MEAS_${q}_FURTHER`,
      active: 6, remaining: 10,
    });

    // A7: endgame — seeker stands at the hider's exact GPS spot (57 m north
    // of the stop) and fires the 100 m radar. Exact radars probe the hider's
    // live GPS -> JA, and the allowed circle is drawn on the seeker map.
    await seekerP.setGps(50.9769, 11.03437);
    await playRound({
      seeker, hider,
      generate: radar(seeker, "100 m"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.97690;11\.03437;0,1km;GPS$/,
      answerFor: (q) => `A_RADAR_${q}_JA`,
      active: 7, remaining: 4,
    });
    await expect(seeker.locator(".leaflet-radarAreas-pane path")).toHaveCount(1);
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simA-06-after-exact-radar.png");

    // The Anger stop must still be on the seeker's map (clicks resolve
    // against the FILTERED stops, so this proves the hideout survived).
    await assertStopPopup(seekerP, [50.9769, 11.03437], STOP.anger);
    await shot(seeker, "simA-07-endgame-popup.png");
  } finally {
    await seekerP.ctx.close();
    await hiderP.ctx.close();
  }
});

// ══════════════════════════════════════════════════════════════
// SIM B — Dorf-Versteck: hideout Gispersleben (north). Radar NEIN,
// thermometer walk (WARMER), bus line 10 JA, Tankstellen measure, Ortsteil
// match NEIN.
// ══════════════════════════════════════════════════════════════

test("SIM B: village game at Gispersleben (thermo walk, bus line, POI measure)", async ({ browser }) => {
  const seekerP = await newPhone(browser, 50.9764, 11.0344, 1600);
  const hiderP = await newPhone(browser, 51.0227, 10.9935);
  const seeker = seekerP.page;
  const hider = hiderP.page;

  try {
    await bootErfurt(seeker, { role: "seeker" });
    await bootErfurt(hider, { role: "hider", hideout: STOP.gispersleben.id });
    await expect(seeker.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
    await expect(hider.getByPlaceholder(PH)).toBeVisible({ timeout: 15_000 });

    // B1: RADAR 2 km at the Anger — Gispersleben is 5.9 km away -> NEIN.
    await playRound({
      seeker, hider,
      generate: radar(seeker, "2 km"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.97640;11\.03440;2km$/,
      answerFor: (q) => `A_RADAR_${q}_NEIN`,
      active: 1, remaining: 166,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simB-01-after-radar-nein.png");

    // B2: thermometer — walk 830 m north (3 GPS fixes), towards the hideout
    // -> WARMER.
    await walkThermo(seekerP, [50.9764, 11.0344], [
      [50.9789, 11.0344],
      [50.9814, 11.0344],
      [50.9839, 11.0344],
    ]);
    await playRound({
      seeker, hider,
      generate: thermoGenerate(seeker),
      codePattern: /^THERMO_[A-Z0-9]{4}_50\.97640;11\.03440_50\.98390;11\.03440_0,75km$/,
      answerFor: (q) => `A_THERMO_${q}_WARMER`,
      active: 2, remaining: 81,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simB-02-after-thermo-warmer.png");

    // B3: bus line 10 — it is the nearest line at the Gispersleben stop -> JA.
    await playRound({
      seeker, hider,
      generate: busline(seeker, "10"),
      codePattern: /^MBUS_[A-Z0-9]{4}_10_50\.98390;11\.03440$/,
      answerFor: (q) => `A_MBUS_${q}_JA`,
      active: 3, remaining: 24,
    });

    // B4: Tankstellen measure from the Riethstraße — seeker 0.47 km, hider
    // 1.10 km -> FURTHER.
    await seekerP.setGps(50.9989, 11.0062);
    await playRound({
      seeker, hider,
      generate: measuring(seeker, "Tankstelle"),
      codePattern: /^MEAS_[A-Z0-9]{4}_tankstellen_0,47_50\.99890;11\.00620$/,
      answerFor: (q) => `A_MEAS_${q}_FURTHER`,
      active: 4, remaining: 18,
    });

    // B5: Ortsteil match back at the Anger — Altstadt vs Gispersleben -> NEIN.
    await seekerP.setGps(50.9764, 11.0344);
    await playRound({
      seeker, hider,
      generate: matching(seeker, "Ortsteil"),
      codePattern: /^MATCH_[A-Z0-9]{4}_O_50\.97640;11\.03440$/,
      answerFor: (q) => `A_MATCH_${q}_NEIN`,
      active: 5, remaining: 18,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simB-03-final-map.png");

    // Endgame: the seekers ride north — the Gispersleben stop survived all
    // five filters and is still clickable on the filtered map.
    await seekerP.setGps(STOP.gispersleben.lat, STOP.gispersleben.lon);
    await assertStopPopup(seekerP, [STOP.gispersleben.lat, STOP.gispersleben.lon], STOP.gispersleben);
    await shot(seeker, "simB-04-endgame-popup.png");
  } finally {
    await seekerP.ctx.close();
    await hiderP.ctx.close();
  }
});

// ══════════════════════════════════════════════════════════════
// SIM C — Voll-Deduktion: hideout Melchendorf (southeast). Seven answers
// narrow 224 stops down to 4: radar NEIN, match NEIN (fully redundant),
// thermometer away from the hideout (COLDER), bus line NEIN, Apotheken
// match JA, KiKA measure FURTHER, 1 km radar JA.
// ══════════════════════════════════════════════════════════════

test("SIM C: full deduction hunt to Melchendorf (7 answers, colder thermo, bus NEIN)", async ({ browser }) => {
  const seekerP = await newPhone(browser, 50.9764, 11.0344, 1600);
  const hiderP = await newPhone(browser, 50.9515, 11.0757);
  const seeker = seekerP.page;
  const hider = hiderP.page;

  try {
    await bootErfurt(seeker, { role: "seeker" });
    await bootErfurt(hider, { role: "hider", hideout: STOP.melchendorf.id });
    await expect(seeker.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
    await expect(hider.getByPlaceholder(PH)).toBeVisible({ timeout: 15_000 });

    // C1: RADAR 2 km at the Anger — Melchendorf is 3.9 km away -> NEIN.
    await playRound({
      seeker, hider,
      generate: radar(seeker, "2 km"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.97640;11\.03440;2km$/,
      answerFor: (q) => `A_RADAR_${q}_NEIN`,
      active: 1, remaining: 166,
    });

    // C2: Ortsteil match at Hbf (Altstadt) -> NEIN. Fully covered by the 2 km
    // radar: the stop count must NOT change.
    await seekerP.setGps(50.9725, 11.0384);
    await playRound({
      seeker, hider,
      generate: matching(seeker, "Ortsteil"),
      codePattern: /^MATCH_[A-Z0-9]{4}_O_50\.97250;11\.03840$/,
      answerFor: (q) => `A_MATCH_${q}_NEIN`,
      active: 2, remaining: 166,
    });

    // C3: thermometer — walk 830 m north, AWAY from Melchendorf -> COLDER.
    await walkThermo(seekerP, [50.965, 11.05], [
      [50.9675, 11.05],
      [50.97, 11.05],
      [50.9725, 11.05],
    ]);
    await playRound({
      seeker, hider,
      generate: thermoGenerate(seeker),
      codePattern: /^THERMO_[A-Z0-9]{4}_50\.96500;11\.05000_50\.97250;11\.05000_0,75km$/,
      answerFor: (q) => `A_THERMO_${q}_COLDER`,
      active: 3, remaining: 63,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simC-01-after-thermo-colder.png");

    // C4: bus line 9 — Melchendorf's nearest lines are 2 and 3 -> NEIN.
    await playRound({
      seeker, hider,
      generate: busline(seeker, "9"),
      codePattern: /^MBUS_[A-Z0-9]{4}_9_50\.97250;11\.05000$/,
      answerFor: (q) => `A_MBUS_${q}_NEIN`,
      active: 4, remaining: 59,
    });

    // C5: Apotheken match at the Melchendorfer Markt — hider and seeker share
    // the "Melchendorfer Apotheke" -> JA. Massive prune: 59 -> 8.
    await seekerP.setGps(50.9498, 11.0767);
    await playRound({
      seeker, hider,
      generate: matching(seeker, "Apotheke"),
      codePattern: /^MPOI_[A-Z0-9]{4}_apotheken_50\.94980;11\.07670_Melchendorfer Apotheke$/,
      answerFor: (q) => `A_MPOI_${q}_JA`,
      active: 5, remaining: 8,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simC-02-after-apotheke-ja.png");

    // C6: KiKA measure from the Domplatz — seeker 0.26 km ("Fidi"), hider
    // 3.8 km -> FURTHER.
    await seekerP.setGps(50.9761, 11.0223);
    await playRound({
      seeker, hider,
      generate: measuring(seeker, "KiKA-Figur"),
      codePattern: /^MEAS_[A-Z0-9]{4}_kika_0,26_50\.97610;11\.02230$/,
      answerFor: (q) => `A_MEAS_${q}_FURTHER`,
      active: 6, remaining: 8,
    });

    // C7: closing in — 1 km radar right at the Melchendorf stop -> JA.
    await seekerP.setGps(50.9519, 11.0751);
    await playRound({
      seeker, hider,
      generate: radar(seeker, "1 km"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.95190;11\.07510;1km$/,
      answerFor: (q) => `A_RADAR_${q}_JA`,
      active: 7, remaining: 4,
    });
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simC-03-final-map.png");

    // Endgame: Melchendorf survived all seven answers and is clickable.
    await assertStopPopup(seekerP, [50.9519, 11.0751], STOP.melchendorf);
    await shot(seeker, "simC-04-endgame-popup.png");
  } finally {
    await seekerP.ctx.close();
    await hiderP.ctx.close();
  }
});

// ══════════════════════════════════════════════════════════════
// SIM D — Sonderregeln & Grenzfälle: hideout Urbicher Kreuz chosen through
// the real map UI; the hider then walks 280 m away from the stop. Covers the
// GPS-vs-stop radar divergence, comma radii, SAME thermometer, lowercase
// codes, invalid codes, unknown answers and the district-letter fallback.
// ══════════════════════════════════════════════════════════════

test("SIM D: edge cases at Urbicher Kreuz (exact GPS rule, SAME thermo, bad codes)", async ({ browser }) => {
  const seekerP = await newPhone(browser, 50.945, 11.09317, 1600);
  const hiderP = await newPhone(browser, STOP.urbich.lat, STOP.urbich.lon);
  const seeker = seekerP.page;
  const hider = hiderP.page;

  try {
    await bootErfurt(seeker, { role: "seeker" });
    await bootErfurt(hider, { role: "hider" }); // no hideout yet!
    await expect(seeker.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
    await expect(hider.getByPlaceholder(PH)).toBeVisible({ timeout: 15_000 });

    // D0: evaluating a code without a hideout must be rejected.
    await hider.getByPlaceholder(PH).fill("RADAR_EE00_50.95276;11.09317;1km");
    await expect(hider.locator(".question-preview-overlay")).toBeVisible();
    await hider.getByRole("button", { name: "Code auswerten" }).click();
    await expect(hider.getByText("Bitte zuerst eine Bushaltestelle auswählen.")).toBeVisible();
    await hider.getByRole("button", { name: "Schließen" }).click();
    await expect(hider.locator(".question-preview-overlay")).toHaveCount(0);

    // D1: choose the hideout through the real map UI (click the stop marker
    // next to the GPS dot, popup button, confirm dialog).
    await expect(hider.locator(".leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
    await expect(hider.locator(".map-center-btn")).toBeEnabled();
    await hider.locator(".map-center-btn").click();
    await hider.waitForTimeout(900);
    const box = (await hider.locator(".map").boundingBox())!;
    await hider.mouse.click(box.x + box.width / 2 + 15, box.y + box.height / 2);
    await hider.getByRole("button", { name: "Als Versteck auswählen" }).click();
    await expect(hider.locator(".question-preview-box")).toContainText("Urbicher Kreuz als Versteck festlegen?");
    await hider.getByRole("button", { name: "Ja", exact: true }).click();
    await expect(hider.locator(".row", { hasText: "Aktuelles Versteck" })).toContainText("Urbicher Kreuz");
    await shot(hider, "simD-01-hideout-selected.png");

    // The hider now walks 280 m north of the stop (still inside the 300 m
    // hide radius) — exact radars must see THIS spot, normal radars the stop.
    await hiderP.setGps(50.95276, 11.09317);

    // D2: real thermometer walk that ends equidistant from the stop
    // (583 m south -> 583 m north of it) -> SAME, and applying the answer
    // filters nothing (224 stops remain).
    await walkThermo(seekerP, [50.945, 11.09317], [
      [50.95024, 11.09317],
      [50.95548, 11.09317],
    ]);
    await playRound({
      seeker, hider,
      generate: thermoGenerate(seeker),
      codePattern: /^THERMO_[A-Z0-9]{4}_50\.94500;11\.09317_50\.95548;11\.09317_0,75km$/,
      answerFor: (q) => `A_THERMO_${q}_SAME`,
      active: 1, remaining: 224,
    });

    // D3: exact 250 m radar fired exactly at the hider's GPS position — the
    // hider is 0 m away (JA) even though the STOP is 280 m away. The answer
    // draws the blue allowed circle and (thanks to the 300 m stop sampling)
    // leaves exactly the one true stop on the map.
    await seekerP.setGps(50.95276, 11.09317);
    // selecting the 250 m preset surfaces the seeker-side exact-GPS warning
    await qBtn(seeker.locator("[data-cat='radar']"), "250 m").click();
    await expect(seeker.getByText(/exakten GPS-Standort/).first()).toBeVisible();
    await playRound({
      seeker, hider,
      generate: radar(seeker, "250 m"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.95276;11\.09317;0,25km;GPS$/,
      answerFor: (q) => `A_RADAR_${q}_JA`,
      beforeEvaluate: async () => {
        // hider-side warning: exact GPS is evaluated, not the stop
        await expect(hider.getByText(/dein exakter GPS-Standort wird geprüft/)).toBeVisible();
      },
      active: 2, remaining: 1,
    });
    await expect(seeker.locator(".leaflet-radarAreas-pane path")).toHaveCount(1);
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simD-02-exact-radar-ja.png");

    // D4: custom radar "0,2" km (German comma!) from the same spot is NOT
    // exact — it probes the STOP, which is 280 m away -> NEIN.
    await playRound({
      seeker, hider,
      generate: radar(seeker, "Custom", "0,2"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.95276;11\.09317;0,2km$/,
      answerFor: (q) => `A_RADAR_${q}_NEIN`,
      active: 3, remaining: 1,
    });

    // D5: codes are case-insensitive — a hand-typed lowercase radar works.
    await hiderAnswer(hider, "radar_lc01_50.95276;11.09317;1km", "A_RADAR_LC01_JA");

    // D6: garbage never opens the evaluation overlay.
    await hider.getByPlaceholder(PH).fill("HALLO WELT 123");
    await hider.waitForTimeout(400);
    await expect(hider.locator(".question-preview-overlay")).toHaveCount(0);

    // D7: seeker-side rejections — garbage, a question code in the answer
    // field, and an answer that matches no asked question.
    const answerField = seeker.getByPlaceholder("A_RADAR_1A2B_JA");
    await answerField.fill("XYZ");
    await seeker.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(seeker.getByText(/Antwort ungültig/)).toBeVisible();
    await answerField.fill("RADAR_EE00_50.95276;11.09317;1km");
    await seeker.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(seeker.getByText("Bitte einen Antwortcode einfügen (A_RADAR_/A_THERMO_/A_MATCH_...).")).toBeVisible();
    await answerField.fill("A_RADAR_ZZZZ_JA");
    await seeker.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(seeker.getByText("Antwort passt zu keiner erzeugten Frage.")).toBeVisible();

    // D8: unknown district letters fall back to the city's first level —
    // a Münster "B" code still evaluates as Ortsteil in Erfurt.
    await hiderAnswer(hider, "MATCH_QQ07_B_50.95024;11.09317", "A_MATCH_QQ07_JA", async () => {
      await expect(hider.getByText(/gleichen Ortsteil/)).toBeVisible();
    });

    // D9: exact 100 m radar from the Anger, far away -> NEIN; the forbidden
    // circle is drawn dashed next to the blue one from D3.
    await seekerP.setGps(50.9764, 11.0344);
    await playRound({
      seeker, hider,
      generate: radar(seeker, "100 m"),
      codePattern: /^RADAR_[A-Z0-9]{4}_50\.97640;11\.03440;0,1km;GPS$/,
      answerFor: (q) => `A_RADAR_${q}_NEIN`,
      active: 4, remaining: 1,
    });
    await expect(seeker.locator(".leaflet-radarAreas-pane path")).toHaveCount(2);
    await seeker.waitForTimeout(1200);
    await shot(seeker, "simD-03-two-radar-areas.png");
  } finally {
    await seekerP.ctx.close();
    await hiderP.ctx.close();
  }
});
