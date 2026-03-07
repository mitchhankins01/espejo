import { type Page, expect } from "@playwright/test";

/** Authenticate by entering a token in the auth gate. In dev (no MCP_SECRET), any token works. */
export async function authenticate(page: Page): Promise<void> {
  await page.goto("/");
  const authInput = page.locator("#auth-token");
  if (await authInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await authInput.fill("test-token");
    await page.locator("button", { hasText: "Sign in" }).click();
    await expect(page.locator("h1", { hasText: "Knowledge Base" })).toBeVisible({ timeout: 10000 });
  }
}
