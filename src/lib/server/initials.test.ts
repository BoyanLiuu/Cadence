import { describe, expect, it } from "vitest";

import { initialsFor } from "./viewer";

/*
 * What this suite is for: the account chip, on every signed-in screen.
 *
 * `users` has no `initials` column — Appendix B keeps the row to what Clerk is
 * the source of truth for — so the chip's two letters are derived on every
 * read. The fixture reader is "Elif Brandt" and gives "EB" whatever the rule
 * is, which is exactly why the rule needs its own test: the cases that break it
 * are the ones no fixture has.
 */

describe("initials for the account chip", () => {
  it("takes the first and LAST name, not the first two", () => {
    // The case that makes this a function rather than a slice: "Maria del
    // Carmen Ruiz" reads as MR. Taking the first two words gives MD, which is
    // a stranger's initials.
    expect(initialsFor("Maria del Carmen Ruiz", "maria@example.com")).toBe("MR");
    expect(initialsFor("Elif Brandt", "elif@example.com")).toBe("EB");
  });

  it("gives two letters for a single name", () => {
    // Clerk accepts a one-word name, and a single letter in a square chip looks
    // like a rendering fault rather than a design. This is also the email-link
    // case: no first or last name in Clerk means `rowFor` stores the address as
    // the display name, so the chip renders "WR" rather than "W".
    expect(initialsFor("Prince", "prince@example.com")).toBe("PR");
    expect(initialsFor("wren@example.com", "wren@example.com")).toBe("WR");
  });

  it("falls back to the address when there is no name at all", () => {
    expect(initialsFor("", "wren@example.com")).toBe("W");
    expect(initialsFor("   ", "wren@example.com")).toBe("W");
  });

  it("returns something rather than crashing on nothing at all", () => {
    // Unreachable through `getViewer()`, which refuses a Clerk user with no
    // address — but this function is exported and the chip must not be the
    // thing that throws during a render.
    expect(initialsFor("", "")).toBe("?");
  });

  it("is always upper case, however the name was typed", () => {
    expect(initialsFor("elif brandt", "elif@example.com")).toBe("EB");
  });

  it("ignores the whitespace a pasted name carries", () => {
    expect(initialsFor("  Elif   Brandt  ", "elif@example.com")).toBe("EB");
  });
});
