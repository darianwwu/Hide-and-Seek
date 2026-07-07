import { test, expect, Page } from "@playwright/test";

const BASE = "/Hide-and-Seek/";
const PH = "RADAR_1A2B_50.97870;11.03280;2km"; // Erfurt placeholder
test.setTimeout(60_000);

// hs_city is read at module load, so set it then reload (like the Münster
// hideout helper). localStorage values are JSON-stringified (lsGet parses them).
async function erfurtStart(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 50.9787, longitude: 11.0328 });
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hs_city", JSON.stringify("erfurt"));
  });
  await page.goto(BASE);
}

async function selectRole(page: Page, role: "hider" | "seeker") {
  await page.getByRole("button", { name: role === "hider" ? "Verstecker" : "Sucher", exact: true }).click();
}

test.describe("Erfurt city", () => {
  test("landing shows the city picker", async ({ page }) => {
    await erfurtStart(page);
    await expect(page.getByRole("heading", { name: "Stadt auswaehlen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Erfurt", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Münster", exact: true })).toBeVisible();
  });

  test("matching card uses a single Ortsteil level (no Bezirk/Stadtbezirk)", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    const card = page.locator("[data-cat='matching']");
    await expect(card.getByRole("button", { name: "Ortsteil", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Bezirk", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Stadtbezirk", exact: true })).toHaveCount(0);
  });

  test("Ortsteil match code uses the Erfurt code letter O", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='matching']").getByRole("button", { name: "Ortsteil", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MATCH_[A-Z0-9]{4}_O_\d+\.\d+;\d+\.\d+$/);
  });

  test("measuring card has Ortsteilgrenze", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await expect(
      page.locator("[data-cat='measuring']").getByRole("button", { name: "Ortsteilgrenze", exact: true }),
    ).toBeVisible();
  });

  test("radar code is centered in Erfurt", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await page.locator("[data-cat='radar']").getByRole("button", { name: "Radar-Code erzeugen" }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    const m = code.match(/^RADAR_[A-Z0-9]{4}_(\d+\.\d+);(\d+\.\d+);/);
    expect(m).not.toBeNull();
    expect(parseFloat(m![1])).toBeGreaterThan(50.8);
    expect(parseFloat(m![1])).toBeLessThan(51.12);
    expect(parseFloat(m![2])).toBeGreaterThan(10.8);
    expect(parseFloat(m![2])).toBeLessThan(11.2);
  });

  test("map renders Erfurt stops", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await page.locator(".leaflet-tile-loaded").first().waitFor({ timeout: 15_000 });
    // Wait for a stop marker that has actually been projected (not the momentary
    // "M0 0" degenerate path Leaflet emits before the view settles).
    await expect
      .poll(async () =>
        page.locator('.leaflet-interactive[d]:not([d="M0 0"])').count(),
      )
      .toBeGreaterThan(0);
  });

  test("POI categories: Tankstelle + Apotheke added, Krankenhaus removed", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    const matching = page.locator("[data-cat='matching']");
    await expect(matching.getByRole("button", { name: "Tankstelle", exact: true })).toBeVisible();
    await expect(matching.getByRole("button", { name: "Apotheke", exact: true })).toBeVisible();
    await expect(matching.getByRole("button", { name: "Krankenhaus", exact: true })).toHaveCount(0);
  });

  test("KiKA-Figur POI category appears in Matching and Measuring", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await expect(
      page.locator("[data-cat='matching']").getByRole("button", { name: "KiKA-Figur", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("[data-cat='measuring']").getByRole("button", { name: "KiKA-Figur", exact: true }),
    ).toBeVisible();
  });

  test("KiKA-Figur match generates an MPOI_..._kika code", async ({ page }) => {
    await erfurtStart(page);
    await selectRole(page, "seeker");
    await page.locator(".leaflet-tile-loaded").first().waitFor({ timeout: 15_000 });
    await page.locator("[data-cat='matching']").getByRole("button", { name: "KiKA-Figur", exact: true }).click();
    const code = await page.locator("textarea[readonly]").first().inputValue();
    expect(code).toMatch(/^MPOI_[A-Z0-9]{4}_kika_\d+\.\d+;\d+\.\d+_.+$/);
  });

  test("hider evaluates an Ortsteil match against an Erfurt hideout", async ({ page }) => {
    await erfurtStart(page);
    await page.evaluate(() => {
      localStorage.setItem("hs_hideout", JSON.stringify("anger"));
      localStorage.setItem("hs_role", JSON.stringify("hider"));
    });
    await page.reload();
    // Reference point == the Anger hideout's own location, so a correctly loaded
    // Erfurt Stadtteile layer must resolve both to the same Ortsteil -> JA.
    // (Under the old bug it loaded Münster districts and always returned NEIN.)
    await page.getByPlaceholder(PH).fill("MATCH_AB12_O_50.97639;11.03437");
    await expect(page.locator(".question-preview-overlay")).toBeVisible();
    await expect(page.getByText(/gleichen Ortsteil/)).toBeVisible();
    await page.getByRole("button", { name: "Code auswerten" }).click();
    const ans = page.locator(".card textarea[readonly]");
    await expect(ans).toBeVisible({ timeout: 10_000 });
    expect(await ans.inputValue()).toBe("A_MATCH_AB12_JA");
  });
});
