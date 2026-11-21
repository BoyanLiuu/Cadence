import { describe, expect, it } from "vitest";

import { articles, feeds, D } from "@/lib/fixtures";

import { iso, isoRequired, num } from "./map";

/*
 * What this suite is for: the two implementations disagreeing over a format
 * nobody can see.
 *
 * `service-parity.test.ts` compares timestamps as STRINGS, because a string is
 * what a component receives and renders. So `2026-11-12T09:12:00Z` and
 * `2026-11-12T09:12:00.000Z` are a FAILURE even though they are the same
 * instant — and that was the state of things: the fixtures emitted one form
 * and `toISOString()` the other, so the seam test that is M6's whole stated
 * deliverable could never have passed.
 *
 * This is checkable with no database, which is why it is here rather than
 * behind a skip.
 */

describe("one canonical timestamp form", () => {
  it("the fixture helper emits exactly what toISOString does", () => {
    const fixture = D("11-12T09:12");
    expect(fixture).toBe(new Date(fixture).toISOString());
    expect(fixture).toBe("2026-11-12T09:12:00.000Z");
  });

  it("every fixture article timestamp round-trips through Date unchanged", () => {
    // The property the parity test depends on, asserted over the whole corpus
    // rather than on one sample.
    for (const article of articles) {
      expect(article.publishedAt).toBe(new Date(article.publishedAt).toISOString());
      expect(article.fetchedAt).toBe(new Date(article.fetchedAt).toISOString());
      if (article.readAt) expect(article.readAt).toBe(new Date(article.readAt).toISOString());
      if (article.savedAt) expect(article.savedAt).toBe(new Date(article.savedAt).toISOString());
    }
  });

  it("every fixture feed timestamp round-trips too", () => {
    for (const feed of feeds) {
      for (const value of [feed.nextFetchAt, feed.lastSuccessAt, feed.lastError?.at]) {
        if (value) expect(value).toBe(new Date(value).toISOString());
      }
      for (const entry of feed.log) {
        expect(entry.at).toBe(new Date(entry.at).toISOString());
      }
    }
  });

  it("the mapper produces the same form from a Date", () => {
    const date = new Date("2026-11-12T09:12:00Z");
    expect(isoRequired(date)).toBe(D("11-12T09:12"));
    expect(iso(date)).toBe(D("11-12T09:12"));
    expect(iso(null)).toBeNull();
  });
});

describe("bigint ids become plain numbers", () => {
  it("converts, because JSON.stringify throws on a BigInt", () => {
    // An unconverted id reaching a Server Component's props is a 500 at render
    // time, not a type error.
    // `BigInt(101)` rather than `101n`: tsconfig targets ES2017, where the
    // literal form is a compile error. The function form is a runtime call
    // and is fine.
    expect(num(BigInt(101))).toBe(101);
    expect(num(101)).toBe(101);
    expect(() => JSON.stringify({ id: num(BigInt(101)) })).not.toThrow();
    // The failure being prevented, stated directly.
    expect(() => JSON.stringify({ id: BigInt(101) })).toThrow();
  });
});
