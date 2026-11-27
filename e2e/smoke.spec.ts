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
  /*
   * "Sign in", not "Continue with GitHub", which is what the comp drew and
   * what this asserted until M15. The card behind it offers GitHub, Google, an
   * email code and a password, so a label naming one provider chose for the
   * reader before they had seen the options.
   *
   * SCOPED TO `main`, because the header carries a "Sign in" link too and
   * `.last()` would pin the assertion to DOM order — which is not what is
   * being claimed. The claim is about the hero's call to action.
   */
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/sign-in",
  );

  /*
   * THE PRODUCT IS ON THE PAGE, which is the M15 change this asserts.
   *
   * It used to check a DRAWING of deduplication — `home-scene.tsx`, now
   * deleted — whose alt text carried the whole figure's meaning so a screen
   * reader did not walk ~40 URL fragments one at a time. The drawing is
   * replaced by a screenshot of the real reading screen, whose own panel shows
   * the same three addresses being reduced to one key.
   *
   * MATCHED ON "Also in 2 feeds", deliberately: that string is what makes the
   * image a picture of the PRODUCT rather than of an idea. A generic
   * screenshot would pass a looser assertion.
   */
  await expect(page.getByRole("img", { name: /Also in 2 feeds/i })).toBeVisible();

  // And the evidence screen, the page's second claim.
  await expect(page.getByRole("img", { name: /feed health table/i })).toBeVisible();

  // The reader's chrome belongs to signed-in surfaces and must not appear here.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

test("the session-ended page offers a way out, as a form and not a link", async ({ page }) => {
  /*
   * ux-04. The page exists because redirecting a stale session to `/sign-in`
   * loops — Clerk still considers the token valid and bounces it back.
   *
   * ASSERTS IT IS A SUBMIT BUTTON INSIDE A FORM, which is the regression worth
   * catching: turning this into `<Link href="/sign-out">` would look identical
   * and sign readers out on hover, because Next prefetches links. A link cannot
   * clear the cookie either — only an action may write one.
   */
  await page.goto("/session-ended");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your session has ended");

  const button = page.getByRole("button", { name: "Sign in again" });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("type", "submit");
  await expect(page.locator("form button[type=submit]")).toHaveCount(1);

  /*
   * A HAND CURSOR, which browsers do not give a `<button>` by default.
   *
   * `cursor: default` is the UA style for every button in every browser, while
   * `<a>` gets the hand for free — so a button looks inert to the pointer next
   * to a link that does not. Fixed in `globals.css`'s base layer on the
   * ELEMENTS rather than on the `Button` component, so a native `<button>`
   * written later is not silently the exception.
   *
   * ASSERTED IN A REAL BROWSER, because that is the only place it is true.
   * The rule lives in Tailwind's generated stylesheet, so a unit test would be
   * reading CSS text rather than observing a cursor — and this project has
   * found that kind of guard weak four times.
   *
   * This is the ONLY page with one of our own buttons that a signed-out
   * browser can reach, which is the limit of the coverage: the reader's
   * buttons are checked by hand. Sign-in's buttons are Clerk's own.
   */
  await expect(button).toHaveCSS("cursor", "pointer");

  // And pressing it leaves, rather than erroring — the whole point of the page.
  await button.click();
  await expect(page).toHaveURL(/\/$/);
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
