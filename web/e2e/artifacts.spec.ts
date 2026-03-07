import { test, expect } from "@playwright/test";
import { authenticate } from "./helpers.ts";

test.describe("Artifact CRUD", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test("list page shows artifacts", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Knowledge Base" })).toBeVisible();
    // Wait for loading to finish
    await page.waitForSelector("[data-testid=artifact-card], [data-testid=empty-state]", { timeout: 5000 });
  });

  test("create, edit, and delete artifact", async ({ page }) => {
    // === CREATE ===
    await page.locator("a[aria-label='New Artifact']").click();
    await expect(page).toHaveURL("/new");

    const timestamp = Date.now();
    const title = `E2E Test ${timestamp}`;

    await page.locator("#create-kind").selectOption("insight");
    await page.locator("#create-title").fill(title);

    const editor = page.locator("[contenteditable=true]").first();
    await editor.click();
    await page.waitForTimeout(200);
    await page.keyboard.type("Test body for e2e.");
    await expect(editor).toContainText("Test body for e2e");

    await page.locator("button", { hasText: "Create Artifact" }).click();
    await page.waitForURL(/\/(?!new)[a-f0-9-]+$/, { timeout: 10000 });

    // Navigate back to list and verify
    await page.locator("a", { hasText: "\u2190" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("[data-testid=artifact-title]", { hasText: title })).toBeVisible();

    // === EDIT ===
    await page.locator("[data-testid=artifact-title]", { hasText: title }).click();

    const titleInput = page.locator("#edit-title");
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await page.waitForFunction(
      () => (document.querySelector("#edit-title") as HTMLInputElement)?.value.length > 0,
      { timeout: 5000 }
    );

    const editedTitle = `${title} (edited)`;
    await titleInput.fill(editedTitle);
    await page.locator("button", { hasText: "Save" }).click();
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await expect(page.locator("[data-testid=artifact-title]", { hasText: editedTitle })).toBeVisible({ timeout: 5000 });

    // Navigate back to the edited artifact for deletion
    await page.locator("[data-testid=artifact-title]", { hasText: editedTitle }).click();
    await expect(page.locator("#edit-title")).toBeVisible({ timeout: 5000 });

    // === DELETE ===
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("button", { hasText: "Delete" }).click();
    await expect(page).toHaveURL("/", { timeout: 5000 });
    await expect(page.locator("[data-testid=artifact-title]", { hasText: editedTitle })).not.toBeVisible();
  });
});
