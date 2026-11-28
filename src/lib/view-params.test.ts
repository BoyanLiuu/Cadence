import { describe, expect, it } from "vitest";

import {
  firstParam,
  hrefForNewResultSet,
  hrefWith,
  pathWith,
  strictId,
  trimmedParam,
} from "./view-params";

/*
 * What this suite is for: links that silently drop the rest of the view.
 *
 * Every reader link was first written as a bare `href="?article=12"`, which
 * REPLACES the whole query string. Nothing failed — the page rendered, the
 * link worked, and the view quietly reset. Three consequences, all of which a
 * reader would read as data loss rather than as a navigation bug:
 *
 *   - opening a row from "All articles" landed in "All unread", where that
 *     article is not listed, so the row they clicked appeared to vanish;
 *   - the pager carried a position from one result set into another: as a
 *     keyset cursor that made every article past it unreachable, and as a page
 *     number it lands the reader on page 4 of a two-page list;
 *   - the Unread/All toggle and the search form navigated out of a folder.
 *
 * None of that is visible in a screenshot of a working page, which is why it
 * needs assertions rather than eyes.
 */

describe("hrefWith keeps the rest of the view", () => {
  it("preserves every other parameter", () => {
    expect(hrefWith({ scope: "all", q: "lathe", folder: "3" }, { article: "124" })).toBe(
      "?scope=all&folder=3&q=lathe&article=124",
    );
  });

  it("keeps the page when opening an article", () => {
    // The bug: clicking a row on page 2 jumped back to page 1.
    const href = hrefWith({ scope: "all", page: "2" }, { article: "300" });
    expect(href).toContain("page=2");
    expect(href).toContain("article=300");
  });

  it("keeps scope and search when changing page", () => {
    const href = hrefWith({ scope: "all", q: "ferry" }, { page: "3" });
    expect(href).toContain("scope=all");
    expect(href).toContain("q=ferry");
  });

  it("overwrites a parameter it is given", () => {
    expect(hrefWith({ page: "2" }, { page: "5" })).toBe("?page=5");
  });

  it("removes a parameter set to null", () => {
    expect(hrefWith({ scope: "all", q: "x" }, { q: null })).toBe("?scope=all");
  });

  it("drops empty values rather than emitting a bare key", () => {
    // `?q=` is a search for nothing, which is not the same as no search.
    expect(hrefWith({ scope: "all", q: "" }, {})).toBe("?scope=all");
  });

  it("returns a usable href when everything is empty", () => {
    expect(hrefWith({}, {})).toBe("?");
  });

  it("emits keys in a fixed order, so equal views are equal strings", () => {
    const a = hrefWith({ q: "x", scope: "all" }, {});
    const b = hrefWith({ scope: "all", q: "x" }, {});
    expect(a).toBe(b);
  });

  it("leaves a page number alone, since it needs no encoding", () => {
    // The cursor this replaced carried a comma and colons and had to be
    // percent-encoded or it split the query string at the wrong place. A page
    // number has no such problem, which is half the reason it reads better in
    // a shared link.
    const href = hrefWith({}, { page: "12" });
    expect(href).toBe("?page=12");
  });
});

describe("hrefForNewResultSet drops what the new set invalidates", () => {
  it("drops the page, because it counts into the old result set", () => {
    // Page 4 of the unread list is not page 4 of anything else. Carried across
    // a scope change it is a blank "no such page" screen in answer to a click
    // on a folder, which reads as the folder being empty.
    const href = hrefForNewResultSet({ scope: "unread", page: "4" }, { scope: "all" });
    expect(href).toBe("?scope=all");
    expect(href).not.toContain("page");
  });

  it("drops the open article, which may not be in the new set", () => {
    const href = hrefForNewResultSet({ scope: "all", article: "113" }, { scope: "unread" });
    expect(href).not.toContain("article");
  });

  it("keeps the search term across a scope change", () => {
    // Switching Unread to All with a search active must not silently clear it.
    expect(hrefForNewResultSet({ q: "ferry" }, { scope: "all" })).toBe("?scope=all&q=ferry");
  });

  it("keeps the folder across a scope change", () => {
    expect(hrefForNewResultSet({ folder: "2" }, { scope: "all" })).toBe("?scope=all&folder=2");
  });
});

describe("pathWith carries the view's shape to another route", () => {
  it("takes scope and search to a feed, but not the page", () => {
    expect(pathWith("/feed/9", { scope: "all", q: "chuck", page: "4", article: "5" })).toBe(
      "/feed/9?scope=all&q=chuck",
    );
  });

  it("returns a bare path when there is nothing to carry", () => {
    expect(pathWith("/feed/9", {})).toBe("/feed/9");
  });

  it("can set a folder while moving to the root", () => {
    expect(pathWith("/reader", { scope: "all" }, { folder: "3" })).toBe(
      "/reader?scope=all&folder=3",
    );
  });

  it("can clear the folder, for the All-unread link", () => {
    expect(pathWith("/reader", { scope: "all", folder: "3" }, { folder: null })).toBe(
      "/reader?scope=all",
    );
  });
});

describe("strictId refuses an id that is not exactly an integer", () => {
  it.each(["12abc", "0012", "12.9", "12 ", " 12", "-1", "0", "", "abc", "1e3", "+1"])(
    "rejects %o",
    (input) => {
      // `Number.parseInt` accepts all of these and returns a number, which
      // gave one feed unlimited URLs: /feed/12abc, /feed/0012 and /feed/12.9
      // all rendered feed 12. One feed with many addresses is one article with
      // many addresses, which is the problem this project is organised against.
      expect(strictId(input)).toBeNull();
    },
  );

  it.each([
    ["1", 1],
    ["12", 12],
    ["101", 101],
  ])("accepts %o as %o", (input, expected) => {
    expect(strictId(input)).toBe(expected);
  });

  it("rejects undefined, so a missing parameter is not an id", () => {
    expect(strictId(undefined)).toBeNull();
  });

  it("rejects a number too large to be safe", () => {
    expect(strictId("9".repeat(25))).toBeNull();
  });
});

describe("firstParam and trimmedParam survive a repeated query key", () => {
  it("takes the first value when the router hands over an array", () => {
    // `?q=a&q=b` is a URL anyone can send, and Next delivers an ARRAY for it.
    // Every route that called `.trim()` on the raw value answered 500 —
    // including /add, whose own input validation had been hardened for exactly
    // this and was then bypassed by the caller trimming first.
    expect(firstParam(["a", "b"])).toBe("a");
    expect(trimmedParam(["  a  ", "b"])).toBe("a");
  });

  it("passes a plain string through", () => {
    expect(firstParam("a")).toBe("a");
    expect(trimmedParam("  a  ")).toBe("a");
  });

  it("reports an absent parameter as undefined, and an empty one as empty", () => {
    expect(firstParam(undefined)).toBeUndefined();
    expect(trimmedParam(undefined)).toBe("");
    expect(trimmedParam("   ")).toBe("");
  });

  it("does not throw on an empty array", () => {
    expect(firstParam([])).toBeUndefined();
    expect(trimmedParam([])).toBe("");
  });
});
