import { describe, expect, it } from "vitest";

import { articles, feeds, D } from "@/lib/fixtures";

import { iso, isoRequired, num, toArticle, toFetchLogEntry } from "./map";

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

describe("mapping a row to what a component renders", () => {
  /** A minimal row, since only the two HTML fields are under test. */
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: BigInt(1),
      feedId: BigInt(1),
      title: "A title",
      author: null,
      url: "https://harbourwire.example/a",
      publishedAt: new Date("2026-11-12T09:00:00.000Z"),
      fetchedAt: new Date("2026-11-12T09:01:00.000Z"),
      textLen: 100,
      summaryHtml: null,
      contentHtml: null,
      extractStatus: "none",
      revisedAt: null,
      revisionCount: 0,
      ...over,
    }) as unknown as Parameters<typeof toArticle>[0];

  it("gives `summary` as PLAIN TEXT, because the list renders it as text", () => {
    /*
     * `article-list/index.tsx` prints `{article.summary}`, which React escapes
     * — so the raw `summary_html` a feed sends reached the screen as literal
     * `<p>` and `<a href="…">` tags in every teaser.
     *
     * The FIXTURES store plain prose, which is why only the Postgres path was
     * wrong and no test saw it. Exactly the shape of the body bug one field
     * along, and found by the same question: what does the reader see?
     */
    const article = toArticle(
      row({ summaryHtml: '<p>The council <a href="/x">voted</a> last night.</p>' }),
      null,
    );

    expect(article.summary).toBe("The council voted last night.");
    expect(article.summary).not.toContain("<");
  });

  it("omits the body unless asked, and never returns the raw column", () => {
    /*
     * `withBody` is off by default because a 50-row list page would otherwise
     * sanitise fifty bodies to discard them. The property that matters is not
     * the saving: it is that the DEFAULT is empty rather than unsanitised, so
     * the only way to get markup out of this function is to ask, and asking
     * cleans it.
     */
    const hostile = "<p>Real</p><script>alert(1)</script>";

    expect(toArticle(row({ contentHtml: hostile }), null).body).toBe("");

    const asked = toArticle(row({ contentHtml: hostile }), null, undefined, { withBody: true });
    expect(asked.body).toContain("Real");
    expect(asked.body).not.toContain("script");
  });
});

describe("one fetch_log row's code, as a screen sees it", () => {
  /** A log row reduced to the two columns `codeOf` reads. */
  const entry = (statusCode: number | null, errorCode: string | null) =>
    toFetchLogEntry({
      at: new Date("2026-11-25T09:00:00.000Z"),
      statusCode,
      errorCode,
      durationMs: 10,
      itemsSeen: 0,
      itemsNew: 0,
      mergedByGuid: 0,
      mergedByUrl: 0,
      mergedByContent: 0,
      revised: 0,
      guidAgreed: 0,
      guidChurned: 0,
    } as unknown as Parameters<typeof toFetchLogEntry>[0]).code;

  it("reports a REFUSED poll by its error, not by the 200 that carried it", () => {
    /*
     * THE BUG THAT MADE M14'S `too_large` WORK UNREACHABLE.
     *
     * `codeOf` returned the HTTP status whenever one existed, on the premise
     * that "a transport failure has no HTTP status — a timeout is not a 0".
     * True of a timeout. Wrong for every failure where we DID get a response
     * and then refused it: `too_large` carries `status: 200`, and so do `html`
     * (a web page where a feed should be) and `parse`.
     *
     * So all three rendered as plain 200s and every screen showed a refused
     * poll as a successful empty read. I added the code to the union, wrote
     * the copy for three screens and a test for the cap — and none of it could
     * ever be reached. Found in review.
     */
    expect(entry(200, "too_large")).toBe("too_large");
    expect(entry(200, "html")).toBe("html");
    expect(entry(200, "parse")).toBe("parse");
  });

  it("still reports a status when there is no error", () => {
    // The case the old order got right, which is why it survived: a 304 is a
    // success with no error code and must stay a 304.
    expect(entry(304, null)).toBe(304);
    expect(entry(200, null)).toBe(200);
    expect(entry(404, null)).toBe(404);
  });

  it("reports a transport failure that has no status at all", () => {
    expect(entry(null, "timeout")).toBe("timeout");
    // An unrecognised code with no status says "we could not read it" rather
    // than inventing a meaning.
    expect(entry(null, "something_new")).toBe("parse");
  });
});
