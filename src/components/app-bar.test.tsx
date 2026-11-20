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
  it("points at the screen that exists", () => {
    // It pointed at `/feeds/new`, which does not exist, so the only entry
    // point to the add-feed screen was a 404.
    render(<AppBar accountName="Elif Brandt" initials="EB" />);
    expect(screen.getByRole("link", { name: /add feed/i })).toHaveAttribute("href", "/add");
  });
});
