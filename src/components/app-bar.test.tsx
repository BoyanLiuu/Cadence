import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppBar } from "./app-bar";

/*
 * What this suite is for: the nav lying about where you are.
 *
 * The bar first hardcoded "Reader" as current, which was wrong on every other
 * screen. The fix added a `current` prop — and defaulted it to "reader", which
 * reproduced the same bug on any screen that forgot to pass it. `/design` did.
 *
 * Marking nothing is merely unhelpful. Marking the WRONG thing tells the
 * reader they are somewhere they are not.
 */

describe("the current nav item", () => {
  it.each([
    ["reader", "Reader"],
    ["saved", "Saved"],
    ["feeds", "Feeds"],
  ] as const)("marks %s", (current, label) => {
    render(<AppBar accountName="Elif Brandt" initials="EB" current={current} />);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  });

  it("marks only one item at a time", () => {
    render(<AppBar accountName="Elif Brandt" initials="EB" current="saved" />);
    for (const label of ["Reader", "Feeds"]) {
      expect(screen.getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    }
  });

  it("DEFAULTS to marking nothing, not to marking Reader", () => {
    // The whole point. A screen that forgets the prop must not claim to be
    // the reader.
    render(<AppBar accountName="Elif Brandt" initials="EB" />);
    for (const label of ["Reader", "Saved", "Feeds"]) {
      expect(screen.getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    }
  });

  it("marks nothing for an explicit none", () => {
    render(<AppBar accountName="Elif Brandt" initials="EB" current="none" />);
    expect(screen.getByRole("link", { name: "Reader" })).not.toHaveAttribute("aria-current");
  });
});

describe("the Add feed button", () => {
  it("is a real control, and no longer a link to a page that moved", () => {
    /*
     * WHAT THIS HAS ALWAYS GUARDED is that an entry point to adding a feed
     * EXISTS. It once pointed at `/feeds/new`, which does not exist, so the
     * only way in was a 404 — that is the bug it was written for.
     *
     * It asserted `href="/add"` until M15, when the control became a dialog
     * trigger: adding a feed is an interruption of reading rather than a
     * destination, so it opens over the screen you are on. `/add` is still a
     * real route for a reload, a shared link, or no JavaScript.
     *
     * NOT OPENED HERE. The dialog fetches the reader's folders through a
     * server action on open, and calling one in jsdom runs `getViewer()` and
     * `auth()` — a server round trip this suite has no business making. So
     * this asserts the trigger and the browser suite would assert the opening;
     * the limit is stated rather than papered over.
     */
    render(<AppBar accountName="Elif Brandt" initials="EB" />);

    expect(screen.getByRole("button", { name: /add feed/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /add feed/i })).not.toBeInTheDocument();
  });
});

describe("signing out", () => {
  /*
   * What this guards: the hover hazard the control's own comment calls "the
   * whole safety of it", which nothing tested.
   *
   * Next PREFETCHES `<Link>`, so `<Link href="/sign-out">` in a header signs a
   * reader out for moving the mouse across the nav — and browsers and scanners
   * prefetch too. Swapping the form for a link would look identical on screen,
   * read more naturally in the JSX, and keep every other test green.
   *
   * A link also could not do the job: clearing a cookie needs an action or a
   * route handler, so a `GET` would have nothing to clear it with.
   */
  it("is a submit button inside a form, never a link", () => {
    render(<AppBar accountName="Elif Brandt" initials="EB" current="reader" />);

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();

    // And nothing in the bar navigates to a sign-out URL.
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("sign-out"));
    expect(hrefs).toEqual([]);
  });
});
