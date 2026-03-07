import { test, expect } from "@playwright/test";

test.describe("Auth Gate", () => {
  test.beforeEach(async ({ page }) => {
    // Clear stored token
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("espejo_token"));
    await page.reload();
  });

  test("shows auth form when not authenticated", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Espejo" })).toBeVisible();
    await expect(page.locator("#auth-token")).toBeVisible();
    await expect(page.locator("button", { hasText: "Sign in" })).toBeVisible();
  });

  test("authenticates with valid token and persists across reload", async ({ page }) => {
    await page.locator("#auth-token").fill("test-token");
    await page.locator("button", { hasText: "Sign in" }).click();
    await expect(page.locator("h1", { hasText: "Knowledge Base" })).toBeVisible({ timeout: 5000 });

    // Token persists across reload
    await page.reload();
    await expect(page.locator("h1", { hasText: "Knowledge Base" })).toBeVisible({ timeout: 5000 });
  });
});
