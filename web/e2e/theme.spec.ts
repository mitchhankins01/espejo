import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers.ts";

test.describe("Theme", () => {
  test("light mode has correct body background", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "light", "light-only test");
    await authenticate(page);
    await page.waitForTimeout(300);

    const bg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    // Light: #f5f8f5 = rgb(245, 248, 245)
    expect(bg).toMatch(/rgba?\(245, 248, 245/);
  });

  test("dark mode has correct body background", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "dark", "dark-only test");
    await authenticate(page);
    await page.waitForTimeout(300);

    const bg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );
    // Dark: #141b17 = rgb(20, 27, 23)
    expect(bg).toMatch(/rgba?\(20, 27, 23/);
  });

  test("dark mode cards have dark surface color", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "dark", "dark-only test");
    await authenticate(page);

    const card = page.locator("[data-testid=artifact-card]").first();
    if (await card.isVisible().catch(() => false)) {
      await page.waitForTimeout(300);
      const cardBg = await card.evaluate((el) =>
        getComputedStyle(el).backgroundColor
      );
      // Dark surface: #1e2722 = rgb(30, 39, 34)
      expect(cardBg).toMatch(/rgba?\(30, 39, 34/);
    }
  });

  test("floating action button is visible", async ({ page }) => {
    await authenticate(page);
    const fab = page.locator("a[aria-label='New Artifact']");
    await expect(fab).toBeVisible();
  });
});
