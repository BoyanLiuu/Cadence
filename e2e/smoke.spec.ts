import { expect, test } from "@playwright/test";

/*
 * The browser suite exists from M0 so M4's first real screen test has somewhere
 * to go. It asserts only that the app boots and the shared chrome is present.
 */
test("the app boots and renders the shared chrome", async ({ page }) => {
  await page.goto("/reader");
  await expect(page.getByRole("link", { name: "Cadence, the reader" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

/*
 * The home page, added in M11 when the reader moved to `/reader`.
 *
 * Covered here because `/` is now what a first-time visitor gets, and the test
 * above used to be the only browser check there was — moving it to `/reader`
 * left the new default route with none at all.
 *
 * It asserts the figure is announced as ONE image rather than as its ~40 URL
 * fragments, which is the part that regressed once already and is invisible to
 * every other check in the project.
 */
test("the home page states the claim and offers a way in", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Three feeds, one story, one unread.",
  );
  await expect(page.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
    "href",
    "/sign-in",
  );

  // One image, with the whole figure's meaning on it.
  const figure = page.getByRole("img", { name: /three feeds under three different addresses/i });
  await expect(figure).toBeVisible();

  // The reader's chrome belongs to signed-in surfaces and must not appear here.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});
