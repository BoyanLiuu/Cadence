import { expect, test } from "@playwright/test";

/*
 * The browser suite, signed OUT.
 *
 * Every test here runs without a session, because that is the only state this
 * runner has: Clerk's bot protection blocks automated sign-up, and an
 * authenticated fixture needs `@clerk/testing` wired up with a test user. Until
 * that exists, the signed-in screens are covered by the unit suites — which
 * resolve `getViewer()` to the fixture reader through `CADENCE_TEST_VIEWER` —
 * and the browser covers what only a browser can: the public page, and the gate
 * in front of everything else.
 *
 * WHAT THIS REPLACES. The one test here used to assert the reader's chrome at
 * `/`, and it survived the move to `/reader` by being pointed at the new path.
 * Review caught that it then broke outright the moment the viewer became real:
 * signed out, `/reader` redirects, so it was asserting the reader's chrome on
 * Clerk's sign-in card. `pnpm check` does not run Playwright, so nothing else
 * would have said so.
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

  // The figure is ONE image, with the whole thing's meaning on it rather than
  // ~40 URL fragments a screen reader would walk one at a time.
  await expect(
    page.getByRole("img", { name: /three feeds under three different addresses/i }),
  ).toBeVisible();

  // The reader's chrome belongs to signed-in surfaces and must not appear here.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

/*
 * §2: there is no public reading surface. Every one of these is somebody's
 * subscription list, so signed out they send you to sign in — and they must do
 * it by REDIRECTING, not by rendering the service's `NotAllowedError` as a 500,
 * which is what they did before `requireViewer()` existed.
 *
 * All five are listed rather than one standing in for the rest, because the
 * gate is per-page: `/design` was missed in the first pass and answered 500 for
 * an anonymous visitor while its four neighbours redirected.
 */
for (const path of ["/reader", "/saved", "/settings/feeds", "/add", "/design"]) {
  test(`${path} sends a signed-out visitor to sign in`, async ({ page }) => {
    const response = await page.goto(path);

    expect(response?.status(), `${path} should not be an error page`).toBeLessThan(400);
    expect(new URL(page.url()).pathname).toBe("/sign-in");

    // And it remembers where they were going, so a shared deep link survives
    // the detour.
    expect(new URL(page.url()).searchParams.get("redirect_url")).toBe(path);
  });
}
