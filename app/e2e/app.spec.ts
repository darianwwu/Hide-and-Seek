import { test, expect, Page } from "@playwright/test";

const BASE = "/Hide-and-Seek/";
test.setTimeout(60_000);
const PH = "RADAR_1A2B_51.96070;7.62610;2km";

async function mockGeo(page: Page, lat = 51.9625, lon = 7.6283) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: lat, longitude: lon });
}

async function freshStart(page: Page) {
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE);
}

async function selectRole(page: Page, role: "hider" | "seeker") {
  await page.getByRole("button", { name: role === "hider" ? "Verstecker" : "Sucher", exact: true }).click();
}

async function waitForMap(page: Page) {
  await page.locator(".leaflet-tile-loaded").first().waitFor({ timeout: 15_000 });
}

async function waitForGps(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll(".leaflet-interactive").length > 0,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
}

async function hiderEvaluate(page: Page, code: string): Promise<string> {
  await page.getByPlaceholder(PH).fill(code);
  await expect(page.locator(".question-preview-overlay")).toBeVisible();
  await page.getByRole("button", { name: "Code auswerten" }).click();
  const answerArea = page.locator(".card textarea[readonly]");
  await expect(answerArea).toBeVisible({ timeout: 10_000 });
  return answerArea.inputValue();
}

async function selectHideout(page: Page, stopId: string) {
  // lsGet uses JSON.parse, so store JSON-stringified values for reload persistence
  await page.evaluate((id) => {
    localStorage.setItem("hs_hideout", JSON.stringify(id));
    localStorage.setItem("hs_role", JSON.stringify("hider"));
  }, stopId);
  await page.reload();
  await expect(page.getByPlaceholder(PH)).toBeVisible({ timeout: 10_000 });
}

// ── Landing Page ──────────────────────────────────────────────

test.describe("Landing Page", () => {
  test("shows role selection buttons", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await expect(page.getByRole("heading", { name: "Rolle auswaehlen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Verstecker", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sucher", exact: true })).toBeVisible();
  });

  test("navigating to hider shows hider panel", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await expect(page.getByRole("heading", { name: "Verstecker" })).toBeVisible();
  });

  test("navigating to seeker shows seeker panel", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await expect(page.getByRole("heading", { name: "Sucher" })).toBeVisible();
  });

  test("Zur Startseite button returns to landing", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await expect(page.getByRole("heading", { name: "Rolle auswaehlen" })).toBeVisible();
  });
});

// ── Game Reset ────────────────────────────────────────────────

test.describe("Game Reset", () => {
  test("reset button shows confirmation dialog", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await page.getByRole("button", { name: "Spiel zuruecksetzen" }).click();
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/Bist du sicher/)).toBeVisible();
  });

  test("cancel does not clear state", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await page.getByRole("button", { name: "Spiel zuruecksetzen" }).click();
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.locator(".question-preview-overlay")).not.toBeVisible();
  });

  test("confirming reset clears game data", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await page.getByRole("button", { name: "Spiel zuruecksetzen" }).click();
    await page.getByRole("button", { name: "Ja, zuruecksetzen" }).click();
    // After reset, hs_role is removed; useEffects write back empty state for other keys
    const askedCodes = await page.evaluate(() => localStorage.getItem("hs_askedCodes"));
    expect(JSON.parse(askedCodes ?? "{}")).toEqual({});
    const appliedAnswers = await page.evaluate(() => localStorage.getItem("hs_appliedAnswers"));
    expect(JSON.parse(appliedAnswers ?? "{}")).toEqual({});
    // The landing page should be shown
    await expect(page.getByRole("heading", { name: "Rolle auswaehlen" })).toBeVisible();
  });
});

// ── Persistence ───────────────────────────────────────────────

test.describe("Persistence", () => {
  test("role is persisted in localStorage", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await expect(page.getByRole("heading", { name: "Sucher" })).toBeVisible();
    const storedRole = await page.evaluate(() => localStorage.getItem("hs_role"));
    expect(storedRole).toBe("seeker");
  });
});

// ── Map ───────────────────────────────────────────────────────

test.describe("Map", () => {
  test("map renders with tiles and bus stops", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await waitForMap(page);
    await expect(page.locator(".leaflet-interactive").first()).toBeVisible();
  });

  test("scale control is shown", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await waitForMap(page);
    await expect(page.locator(".leaflet-control-scale")).toBeVisible();
  });

  test("center button is present", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await waitForMap(page);
    await expect(page.locator(".map-center-btn")).toBeVisible();
  });
});

// ── POI Layers ────────────────────────────────────────────────

test.describe("POI Layers Menu", () => {
  test("POI menu toggles open/closed", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const toggle = page.locator(".poi-menu-toggle").first();
    await toggle.click();
    await expect(page.locator(".poi-menu-list").first()).toBeVisible();
    await toggle.click();
    await expect(page.locator(".poi-menu-list")).not.toBeVisible();
  });

  test("POI menu includes border and busline layers", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator(".poi-menu-toggle").first().click();
    const menuList = page.locator(".poi-menu-list").first();
    await expect(menuList.getByText("Bezirksgrenzen", { exact: true })).toBeVisible();
    await expect(menuList.getByText("Stadtbezirksgrenzen", { exact: true })).toBeVisible();
    await expect(menuList.getByText("Buslinien")).toBeVisible();
  });
});

// ── Hider Panel ───────────────────────────────────────────────

test.describe("Hider Panel", () => {
  test("shows default state with no hideout selected", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await expect(page.getByText("Noch nicht")).toBeVisible();
  });

  test("question code input area exists", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await expect(page.getByPlaceholder(PH)).toBeVisible();
  });

  test("pasting a valid RADAR code shows preview overlay", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("RADAR_AB12_51.96250;7.62830;1km");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/Umkreis von 1000 Metern/)).toBeVisible();
  });

  test("pasting a valid MATCH code shows preview with Bezirk", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MATCH_CD34_B_51.96250;7.62830");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/gleichen Bezirk/)).toBeVisible();
  });

  test("pasting a valid MATCH_STADTBEZIRK code shows preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MATCH_EF56_S_51.96250;7.62830");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/gleichen Stadtbezirk/)).toBeVisible();
  });

  test("pasting a valid MPOI code shows POI matching preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MPOI_GH78_schulen_51.96250;7.62830_Friedensschule");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    // Scope to the overlay to avoid matching the input textarea
    await expect(page.locator(".question-preview-text")).toContainText("Friedensschule");
  });

  test("pasting a valid MBUS code shows busline matching preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MBUS_IJ90_1_51.96250;7.62830");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.locator(".question-preview-text")).toContainText("Linie 1");
  });

  test("pasting a valid MSTR code shows street matching preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MSTR_KL12_51.96250;7.62830_Prinzipalmarkt");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.locator(".question-preview-text")).toContainText("Prinzipalmarkt");
  });

  test("pasting a valid MEAS code shows measuring preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("MEAS_MN34_kitas_0,5_51.96250;7.62830");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.locator(".question-preview-text")).toContainText("500 Meter");
  });

  test("evaluating RADAR code produces an answer code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;1km");
    expect(answerCode).toMatch(/^A_RADAR_AB12_(JA|NEIN)$/);
  });

  test("evaluating RADAR code at exact center produces JA", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;1km");
    expect(answerCode).toBe("A_RADAR_AB12_JA");
  });

  test("evaluating RADAR code far away produces NEIN", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "waldfriedhof lauheide");
    const answerCode = await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;1km");
    expect(answerCode).toBe("A_RADAR_AB12_NEIN");
  });

  test("evaluating THERMO code produces WARMER", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "THERMO_CD34_52.00000;7.70000_51.96300;7.62900");
    expect(answerCode).toBe("A_THERMO_CD34_WARMER");
  });

  test("evaluating THERMO code produces COLDER", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "THERMO_EF56_51.96300;7.62900_52.00000;7.70000");
    expect(answerCode).toBe("A_THERMO_EF56_COLDER");
  });

  test("evaluating MATCH_DISTRICT bezirk code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MATCH_GH78_B_51.96250;7.62830");
    expect(answerCode).toBe("A_MATCH_GH78_JA");
  });

  test("evaluating MATCH_DISTRICT stadtbezirk code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MATCH_IJ90_S_51.96250;7.62830");
    expect(answerCode).toBe("A_MATCH_IJ90_JA");
  });

  test("evaluating MPOI code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MPOI_KL12_schulen_51.96250;7.62830_TestSchule");
    expect(answerCode).toMatch(/^A_MPOI_KL12_(JA|NEIN)$/);
  });

  test("evaluating MEAS kitas code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MEAS_MN34_kitas_0,5_51.96250;7.62830");
    expect(answerCode).toMatch(/^A_MEAS_MN34_(CLOSER|FURTHER)$/);
  });

  test("evaluating MEAS border_bezirk code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MEAS_OP56_border_bezirk_1,0_51.96250;7.62830");
    expect(answerCode).toMatch(/^A_MEAS_OP56_(CLOSER|FURTHER)$/);
  });

  test("evaluating MEAS border_stadtbezirk code", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, "MEAS_QR78_border_stadtbezirk_2,0_51.96250;7.62830");
    expect(answerCode).toMatch(/^A_MEAS_QR78_(CLOSER|FURTHER)$/);
  });

  test("invalid code does not show preview", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("TOTALLY_INVALID");
    await expect(page.locator(".question-preview-overlay")).not.toBeVisible();
  });

  test("small RADAR (0.1km) preview shows GPS note", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.getByPlaceholder(PH).fill("RADAR_AB12_51.96250;7.62830;0,1km");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.locator(".question-preview-box")).toContainText("exakter GPS-Standort");
  });

  test("evaluating small RADAR (0.1km) uses GPS – JA when GPS at center, stop far away", async ({ page }) => {
    // GPS near radar center; far-away bus stop must NOT be used
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "waldfriedhof lauheide");
    await waitForGps(page);
    const answerCode = await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;0,1km");
    expect(answerCode).toBe("A_RADAR_AB12_JA");
  });

  test("evaluating small RADAR (0.1km) uses GPS – NEIN when GPS far away, stop near center", async ({ page }) => {
    // GPS far from radar center; near bus stop must NOT be used
    await mockGeo(page, 52.0, 8.0);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    await waitForGps(page);
    const answerCode = await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;0,1km");
    expect(answerCode).toBe("A_RADAR_AB12_NEIN");
  });
});

// ── Hider Question Overview ───────────────────────────────────

test.describe("Hider Question Overview", () => {
  test("overview is collapsible", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    const toggle = page.locator("button.poi-menu-toggle", { hasText: /Fragen/ });
    await toggle.click();
    await expect(page.locator(".hider-overview")).toBeVisible();
    await toggle.click();
    await expect(page.locator(".hider-overview")).not.toBeVisible();
  });

  test("overview shows all category groups", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.locator("button.poi-menu-toggle", { hasText: /Fragen/ }).click();
    const overview = page.locator(".hider-overview");
    await expect(overview.getByRole("heading", { name: /Radar/ })).toBeVisible();
    await expect(overview.getByRole("heading", { name: /Thermometer/ })).toBeVisible();
    await expect(overview.getByRole("heading", { name: /Matching/ })).toBeVisible();
    await expect(overview.getByRole("heading", { name: /Measuring/ })).toBeVisible();
    await expect(overview.getByRole("heading", { name: /Foto/ })).toBeVisible();
  });

  test("foto question in overview opens confirm dialog", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.locator("button.poi-menu-toggle", { hasText: /Fragen/ }).click();
    await page.locator(".hider-overview").getByText("Baum").click();
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/ganzen Baum/)).toBeVisible();
  });

  test("marking a foto question as asked tracks it", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "hider");
    await page.locator("button.poi-menu-toggle", { hasText: /Fragen/ }).click();
    await page.locator(".hider-overview .q-btn").filter({ hasText: "Selfie" }).click();
    await page.getByRole("button", { name: /Als gestellt markieren/ }).click();
    // The Selfie button should now show the count badge
    await expect(page.locator(".hider-overview .q-btn-count").first()).toBeVisible();
  });

  test("evaluating code tracks the question in overview", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;1km");
    await page.locator("button.poi-menu-toggle", { hasText: /Fragen/ }).click();
    const radarBtn = page.locator(".hider-overview .q-btn").filter({ hasText: "1 km" }).first();
    await expect(radarBtn).toHaveClass(/q-btn--used/);
  });

  test("double question shows doubled reward", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    await hiderEvaluate(page, "RADAR_AB12_51.96250;7.62830;1km");
    await page.getByPlaceholder(PH).fill("RADAR_CD34_51.96250;7.62830;1km");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/doppelte Belohnung/)).toBeVisible();
  });
});

// ── Seeker Panel UI Structure ─────────────────────────────────

test.describe("Seeker Panel - UI Structure", () => {
  test("all question category cards are visible", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await expect(page.locator("[data-cat='radar']")).toBeVisible();
    await expect(page.locator("[data-cat='thermo']")).toBeVisible();
    await expect(page.locator("[data-cat='matching']")).toBeVisible();
    await expect(page.locator("[data-cat='measuring']")).toBeVisible();
    await expect(page.locator("[data-cat='foto']")).toBeVisible();
  });

  test("radar preset buttons work", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='radar']");
    await card.getByRole("button", { name: "250 m" }).click();
    await expect(card.getByText("Aktiv: 0,25 km")).toBeVisible();
    await card.getByRole("button", { name: "2 km" }).click();
    await expect(card.getByText("Aktiv: 2 km")).toBeVisible();
  });

  test("small radar presets show GPS note, large presets hide it", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='radar']");
    for (const label of ["100 m", "250 m", "500 m"]) {
      await card.getByRole("button", { name: label }).click();
      await expect(card.getByText(/exakten GPS-Standort/)).toBeVisible();
    }
    for (const label of ["1 km", "2 km"]) {
      await card.getByRole("button", { name: label }).click();
      await expect(card.getByText(/exakten GPS-Standort/)).not.toBeVisible();
    }
  });

  test("custom radar input appears when Custom selected", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='radar']");
    await card.getByRole("button", { name: "Custom" }).click();
    await expect(card.getByPlaceholder("z. B.")).toBeVisible();
  });

  test("matching card has all expected buttons", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='matching']");
    await expect(card.getByRole("button", { name: "Bezirk", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Stadtbezirk", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Kita", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Schule", exact: true })).toBeVisible();
  });

  test("measuring card has border and POI buttons", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='measuring']");
    await expect(card.getByRole("button", { name: "Bezirksgrenze", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Stadtbezirksgrenze", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Kita", exact: true })).toBeVisible();
  });

  test("foto card has photo question buttons", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='foto']");
    for (const label of ["Baum", "Selfie", "Himmel", "Bushaltestelle"]) {
      await expect(card.locator(".q-btn").filter({ hasText: label })).toBeVisible();
    }
  });

  test("answer input area exists", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await expect(page.getByPlaceholder("A_RADAR_1A2B_JA")).toBeVisible();
    await expect(page.getByRole("button", { name: "Antwort anwenden" })).toBeVisible();
  });

  test("active filter count shows", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await expect(page.getByText(/0 Antworten aktiv/)).toBeVisible();
  });
});

// ── Seeker: Generate Question Codes ───────────────────────────

test.describe("Seeker Question Code Generation", () => {
  test("radar code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='radar']").getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const codeArea = page.locator("textarea[readonly]").first();
    await expect(codeArea).not.toHaveValue("");
    const code = await codeArea.inputValue();
    expect(code).toMatch(/^RADAR_[A-Z0-9]{4}_\d+\.\d+;\d+\.\d+;\d+(?:,\d+)?km$/);
  });

  test("matching bezirk code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Bezirk", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MATCH_[A-Z0-9]{4}_B_\d+\.\d+;\d+\.\d+$/);
  });

  test("matching stadtbezirk code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Stadtbezirk", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MATCH_[A-Z0-9]{4}_S_\d+\.\d+;\d+\.\d+$/);
  });

  test("matching POI kita code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Kita", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MPOI_[A-Z0-9]{4}_kitas_\d+\.\d+;\d+\.\d+_.+$/);
  });

  test("matching POI schule code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Schule", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MPOI_[A-Z0-9]{4}_schulen_\d+\.\d+;\d+\.\d+_.+$/);
  });

  test("measuring kita code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='measuring']").getByRole("button", { name: "Kita", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MEAS_[A-Z0-9]{4}_kitas_\d+(?:,\d+)?_\d+\.\d+;\d+\.\d+$/);
  });

  test("measuring bezirksgrenze code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='measuring']").getByRole("button", { name: "Bezirksgrenze", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MEAS_[A-Z0-9]{4}_border_bezirk_\d+(?:,\d+)?_\d+\.\d+;\d+\.\d+$/);
  });

  test("measuring stadtbezirksgrenze code is generated", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='measuring']").getByRole("button", { name: "Stadtbezirksgrenze", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MEAS_[A-Z0-9]{4}_border_stadtbezirk_\d+(?:,\d+)?_\d+\.\d+;\d+\.\d+$/);
  });
});

// ── Seeker: Apply Answer Codes ────────────────────────────────

test.describe("Seeker Apply Answers", () => {
  test("applying answer without matching question fails", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill("A_RADAR_AB12_JA");
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/passt zu keiner/)).toBeVisible();
  });

  test("applying a matching answer to a generated question works", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='radar']").getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    const qid = code.match(/^RADAR_([A-Z0-9]{4})_/)![1];
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(`A_RADAR_${qid}_JA`);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/Antwort angewendet/)).toBeVisible();
    await expect(page.getByText(/1 Antworten aktiv/)).toBeVisible();
  });

  test("applying answer marks the radar button as used", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    const radarCard = page.locator("[data-cat='radar']");
    await radarCard.getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    const qid = code.match(/^RADAR_([A-Z0-9]{4})_/)![1];
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(`A_RADAR_${qid}_JA`);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    // The "1 km" preset button (default) should be marked as used
    const presetBtn = radarCard.getByRole("button", { name: "1 km" });
    await expect(presetBtn).toHaveClass(/q-btn--used/);
  });
});

// ── Seeker Foto Questions ─────────────────────────────────────

test.describe("Seeker Foto Questions", () => {
  test("clicking foto question shows confirmation with description", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='foto'] .q-btn").filter({ hasText: "Baum" }).click();
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/ganzen Baum/)).toBeVisible();
  });

  test("confirming foto question marks it as used", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const btn = page.locator("[data-cat='foto'] .q-btn").filter({ hasText: "Himmel" });
    await btn.click();
    await page.getByRole("button", { name: /Ja, stellen/ }).click();
    await expect(btn).toHaveClass(/q-btn--used/);
  });

  test("using foto question twice marks it as exhausted", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const btn = page.locator("[data-cat='foto'] .q-btn").filter({ hasText: "Baum" });
    await btn.click();
    await page.getByRole("button", { name: /Ja, stellen/ }).click();
    // After first use, button has q-btn--used; click again (::after adds checkmark)
    await btn.click({ force: true });
    await page.getByRole("button", { name: /Ja, stellen/ }).click();
    await expect(btn).toHaveClass(/q-btn--exhausted/);
  });

  test("second foto question shows doubled reward", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const btn = page.locator("[data-cat='foto'] .q-btn").filter({ hasText: "Selfie" });
    await btn.click();
    await page.getByRole("button", { name: /Ja, stellen/ }).click();
    await btn.click({ force: true });
    await expect(page.getByText(/doppelte Belohnung/)).toBeVisible();
  });

  test("foto descriptions appear in confirmation dialogs", async ({ page }) => {
    await mockGeo(page);
    await freshStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='foto']");

    const checks: [string, RegExp][] = [
      ["Baum", /ganzen Baum/],
      ["Selfie", /Arm ganz ausgestreckt/],
      ["Himmel", /Handy parallel/],
    ];

    for (const [label, descPattern] of checks) {
      await card.locator(".q-btn").filter({ hasText: label }).click();
      await expect(page.locator(".question-preview-text")).toContainText(label);
      await expect(page.locator(".question-preview-box")).toContainText(descPattern);
      await page.getByRole("button", { name: "Abbrechen" }).click();
    }
  });
});

// ── Full Round-Trip Scenarios ─────────────────────────────────

test.describe("Full Round-Trip Scenarios", () => {
  test("RADAR round-trip: generate, evaluate, apply, filter", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='radar']").getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const questionCode = await page.locator("textarea[readonly]").first().inputValue();
    const qid = questionCode.match(/^RADAR_([A-Z0-9]{4})_/)![1];
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, questionCode);
    expect(answerCode).toMatch(/^A_RADAR_/);
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "seeker");
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(answerCode);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/Antwort angewendet/)).toBeVisible();
    await expect(page.getByText(/1 Antworten aktiv/)).toBeVisible();
  });

  test("MATCH_DISTRICT bezirk round-trip", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Bezirk", exact: true }).click();
    const questionCode = await page.locator("textarea[readonly]").first().inputValue();
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, questionCode);
    expect(answerCode).toMatch(/^A_MATCH_.*_(JA|NEIN)$/);
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "seeker");
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(answerCode);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/Antwort angewendet/)).toBeVisible();
  });

  test("MPOI round-trip for schulen", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Schule", exact: true }).click();
    const questionCode = await page.locator("textarea[readonly]").first().inputValue();
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, questionCode);
    expect(answerCode).toMatch(/^A_MPOI_.*_(JA|NEIN)$/);
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "seeker");
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(answerCode);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/Antwort angewendet/)).toBeVisible();
  });

  test("MEAS round-trip for kitas", async ({ page }) => {
    await mockGeo(page, 51.9625, 7.6283);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='measuring']").getByRole("button", { name: "Kita", exact: true }).click();
    const questionCode = await page.locator("textarea[readonly]").first().inputValue();
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "hider");
    await selectHideout(page, "prinzipalmarkt");
    const answerCode = await hiderEvaluate(page, questionCode);
    expect(answerCode).toMatch(/^A_MEAS_.*_(CLOSER|FURTHER)$/);
    await page.getByRole("button", { name: "Zur Startseite" }).click();
    await selectRole(page, "seeker");
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(answerCode);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    await expect(page.getByText(/Antwort angewendet/)).toBeVisible();
  });
});

// ── Seeker Stop Filtering ─────────────────────────────────────

test.describe("Seeker Stop Filtering", () => {
  test("RADAR JA answer reduces stop count", async ({ page }) => {
    await mockGeo(page, 52.0, 7.7);
    await freshStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='radar']").getByRole("button", { name: "250 m" }).click();
    await page.locator("[data-cat='radar']").getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    const qid = code.match(/^RADAR_([A-Z0-9]{4})_/)![1];
    await page.getByPlaceholder("A_RADAR_1A2B_JA").fill(`A_RADAR_${qid}_JA`);
    await page.getByRole("button", { name: "Antwort anwenden" }).click();
    const text = await page.getByText(/Haltestellen verbleiben/).textContent();
    const count = parseInt(text!.match(/(\d+) Haltestellen/)?.[1] ?? "999");
    expect(count).toBeLessThan(50);
  });
});
