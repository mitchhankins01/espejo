import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers.ts";

test.describe("Filters and Pagination", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await page.waitForSelector("[data-testid=artifact-card], [data-testid=empty-state]", { timeout: 5000 });
  });

  test("kind filter pills narrow results", async ({ page }) => {
    const allCards = await page.locator("[data-testid=artifact-card]").count();
    if (allCards === 0) return;

    // Click "Insight" filter pill
    await page.locator("button", { hasText: "Insight" }).click();
    await page.waitForSelector("[data-testid=artifact-card], [data-testid=empty-state]", { timeout: 5000 });

    // Every visible badge should match the filter
    const badges = page.locator("[data-testid=kind-badge]");
    const count = await badges.count();
    for (let i = 0; i < count; i++) {
      await expect(badges.nth(i)).toHaveText("insight");
    }

    // Click "All" to reset and wait for data to reload
    await page.locator("button", { hasText: "All" }).click();
    await page.waitForTimeout(500);
    await page.waitForSelector("[data-testid=artifact-card], [data-testid=empty-state]", { timeout: 5000 });
    const resetCards = await page.locator("[data-testid=artifact-card]").count();
    expect(resetCards).toBeGreaterThanOrEqual(count);
  });

  test("search shows results or empty state", async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search artifacts..."]');
    await searchInput.fill("test");
    await page.waitForFunction(
      () => !document.querySelector("[data-testid=loading]"),
      { timeout: 10000 }
    );

    const isEmpty = await page.locator("[data-testid=empty-state]").isVisible().catch(() => false);
    const hasResults = await page.locator("[data-testid=artifact-card]").first().isVisible().catch(() => false);
    expect(isEmpty || hasResults).toBe(true);
  });

  test("pagination shows when items exceed page size", async ({ page }) => {
    const cards = await page.locator("[data-testid=artifact-card]").count();
    const pagination = page.locator("[data-testid=pagination]");

    if (cards >= 10) {
      await expect(pagination).toBeVisible();
      await expect(page.locator("[data-testid=pagination-info]")).toContainText("Page 1 of");

      const prevBtn = pagination.locator("button", { hasText: "Previous" });
      await expect(prevBtn).toBeDisabled();

      const nextBtn = pagination.locator("button", { hasText: "Next" });
      if (await nextBtn.isEnabled()) {
        await nextBtn.click();
        await page.waitForSelector("[data-testid=artifact-card]", { timeout: 5000 });
        await expect(page.locator("[data-testid=pagination-info]")).toContainText("Page 2 of");
        await expect(prevBtn).toBeEnabled();
      }
    }
  });
});
