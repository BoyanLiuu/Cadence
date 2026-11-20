import { expect, test } from "@playwright/test";

/*
 * The browser suite exists from M0 so M4's first real screen test has somewhere
 * to go. It asserts only that the app boots and the shared chrome is present.
 */
test("the app boots and renders the shared chrome", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Cadence, the reader" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});
