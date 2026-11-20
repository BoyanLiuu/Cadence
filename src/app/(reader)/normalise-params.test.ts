import { describe, expect, it } from "vitest";

import { hrefWith, type ReaderParams } from "@/lib/view-params";

import { normaliseParams } from "./normalise-params";

/*
 * What this suite is for: a normaliser that drops a key it forgot about.
 *
 * `reader-view.tsx` rebuilds `ReaderParams` from the raw search params so that
 * `?q=a&q=b` cannot 500. The risk is the rebuild being INCOMPLETE — and it was:
 * the first version listed five of the six keys and omitted `shortcuts`, so
 * every link on the page silently dropped it. That is the exact failure
 * `view-params.ts` was written to prevent, reintroduced by the fix for a
 * different bug.
 *
 * So this asserts the property rather than the implementation: whatever keys
 * `ReaderParams` has, the normaliser must carry all of them.
 */

/** The keys the router may deliver, which is every key of `ReaderParams`. */
const ALL_KEYS: (keyof ReaderParams)[] = ["scope", "folder", "q", "before", "article", "shortcuts"];

describe("the normaliser must cover every ReaderParams key", () => {
  it("has a known, enumerated key list", () => {
    // If `ReaderParams` grows a key, this fails and whoever added it has to
    // decide whether the normaliser carries it — rather than finding out from
    // a link that quietly stopped working.
    const sample: Required<ReaderParams> = {
      scope: "all",
      folder: "1",
      q: "x",
      before: "2026-01-01T00:00:00Z,1",
      article: "101",
      shortcuts: "1",
    };
    expect(Object.keys(sample).sort()).toEqual([...ALL_KEYS].sort());
  });

  it("round-trips every key through hrefWith", () => {
    // The practical consequence: a key the normaliser drops is a key no link
    // can preserve, however correct `hrefWith` is.
    const full: Required<ReaderParams> = {
      scope: "all",
      folder: "2",
      q: "ferry",
      before: "2026-01-01T00:00:00Z,9",
      article: "101",
      shortcuts: "1",
    };
    const href = hrefWith(full, {});
    const parsed = new URLSearchParams(href.slice(1));
    for (const key of ALL_KEYS) {
      expect(parsed.get(key), `hrefWith dropped ${key}`).toBe(full[key]);
    }
  });

  it("keeps shortcuts across a row click, which is where it was lost", () => {
    const href = hrefWith({ scope: "all", shortcuts: "1" }, { article: "101" });
    expect(href).toContain("shortcuts=1");
    expect(href).toContain("article=101");
  });

  it("keeps shortcuts across a scope change, which resets other things", () => {
    // `hrefForNewResultSet` drops the cursor and the open article. It must not
    // drop the dialog the reader has open.
    const href = hrefWith({ shortcuts: "1" }, { scope: "unread", before: null, article: null });
    expect(href).toContain("shortcuts=1");
  });
});

describe("a whitespace-only query is absent, not empty", () => {
  it("emits no q at all", () => {
    // `/?q=%20%20` rendered no search while emitting `q=++` into every link on
    // the page, because the trim happened in a local and the raw value went
    // into the params. One normalised value, used everywhere.
    expect(hrefWith({ scope: "all", q: undefined }, {})).toBe("?scope=all");
    expect(hrefWith({ scope: "all", q: "" }, {})).toBe("?scope=all");
  });

  it("still emits a real query", () => {
    expect(hrefWith({ q: "ferry" }, {})).toBe("?q=ferry");
  });
});

describe("normaliseParams carries every key", () => {
  it("carries all six, including shortcuts", () => {
    // The omission that reintroduced the dropped-param bug. Asserted by
    // KEY LIST rather than one-by-one, so a seventh key cannot be forgotten.
    const out = normaliseParams({
      scope: "all",
      folder: "2",
      q: "ferry",
      before: "2026-01-01T00:00:00Z,9",
      article: "101",
      shortcuts: "1",
    });
    for (const key of ALL_KEYS) {
      expect(out[key], `normaliseParams dropped ${key}`).toBeDefined();
    }
  });

  it("takes the first value of a repeated key rather than throwing", () => {
    // `?q=a&q=b` answered 500 before this existed.
    const out = normaliseParams({ q: ["a", "b"], scope: ["all", "unread"] });
    expect(out.q).toBe("a");
    expect(out.scope).toBe("all");
  });

  it("treats a whitespace-only query as absent", () => {
    expect(normaliseParams({ q: "   " }).q).toBeUndefined();
    expect(normaliseParams({ q: ["  ", "x"] }).q).toBeUndefined();
  });

  it("trims a real query", () => {
    expect(normaliseParams({ q: "  ferry  " }).q).toBe("ferry");
  });

  it("leaves absent keys undefined rather than empty", () => {
    const out = normaliseParams({});
    for (const key of ALL_KEYS) expect(out[key]).toBeUndefined();
    // So `hrefWith` emits nothing for them.
    expect(hrefWith(out, {})).toBe("?");
  });

  it("survives an empty array, which a stripped query string can produce", () => {
    expect(normaliseParams({ q: [], scope: [] }).q).toBeUndefined();
  });

  it("produces links that keep the whole view", () => {
    // The end-to-end property: normalise, then build a link, and nothing is
    // lost on the way through.
    const raw = { scope: "all", q: ["ferry"], shortcuts: "1", before: "x,1" };
    const href = hrefWith(normaliseParams(raw), { article: "101" });
    for (const fragment of ["scope=all", "q=ferry", "shortcuts=1", "article=101"]) {
      expect(href).toContain(fragment);
    }
  });
});
