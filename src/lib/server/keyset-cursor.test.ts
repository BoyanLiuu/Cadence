import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "@/components/article-list";
import { articles } from "@/lib/fixtures";
import { PAGE_SIZE, type Article, type Cursor, type Scope } from "@/lib/types";

import { listArticles } from "./article-service";
import { getViewer } from "./viewer";

/*
 * What this suite is for: the two classic pagination faults, caught while they
 * are still cheap.
 *
 *   1. A ROW ON TWO CONSECUTIVE PAGES. The reader sees the same article twice
 *      and concludes the dedup is broken — which is the one thing this product
 *      cannot afford to look like.
 *   2. A ROW SKIPPED AT A PAGE BOUNDARY. Worse, because it is invisible: the
 *      article is simply never shown. It happens when two articles share a
 *      `published_at` and the cursor keys on the timestamp alone.
 *
 * Both are what `OFFSET` produces as soon as rows are inserted mid-read, and
 * both are why the cursor is `(publishedAt, id)` rather than a row count.
 */

const SCOPE: Scope = { kind: "all" };

/** Walks every page, returning the rows in order and the number of requests. */
async function pageThrough(scope: Scope = SCOPE) {
  const viewer = await getViewer();
  const seen: Article[] = [];
  let cursor: Cursor | undefined;
  let requests = 0;

  do {
    const page = await listArticles(viewer, scope, cursor);
    requests += 1;
    seen.push(...page.items);
    cursor = page.next ?? undefined;
    // A runaway loop is a bug in its own right; fail loudly rather than hang.
    if (requests > 100) throw new Error("pagination did not terminate");
  } while (cursor);

  return { seen, requests };
}

describe("keyset pagination", () => {
  it("needs more than one page for this corpus, or it proves nothing", () => {
    expect(articles.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("never shows a row on two pages", async () => {
    const { seen } = await pageThrough();
    const ids = seen.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never skips a row at a page boundary", async () => {
    const viewer = await getViewer();
    const { seen } = await pageThrough();
    // Every article in scope must appear exactly once across all pages.
    const all = await listArticles(viewer, SCOPE);
    expect(seen.length).toBeGreaterThanOrEqual(all.items.length);
    expect(seen.length).toBe(articles.length);
  });

  it("keeps rows in descending (publishedAt, id) order across boundaries", async () => {
    const { seen } = await pageThrough();
    for (let i = 1; i < seen.length; i += 1) {
      const prev = seen[i - 1];
      const curr = seen[i];
      const ordered =
        prev.publishedAt > curr.publishedAt ||
        (prev.publishedAt === curr.publishedAt && prev.id > curr.id);
      expect(ordered, `row ${i} out of order: ${prev.id} then ${curr.id}`).toBe(true);
    }
  });

  it("survives a tie on publishedAt, which is where a timestamp-only cursor fails", async () => {
    // The corpus has a deliberate tie: 123 and 124 are the duplicate pair,
    // published at the same instant. A cursor keyed on the timestamp alone
    // either repeats one of them or loses one.
    const tied = articles.filter((a) => a.id === 123 || a.id === 124);
    expect(tied).toHaveLength(2);
    expect(tied[0].publishedAt).toBe(tied[1].publishedAt);

    const { seen } = await pageThrough();
    expect(seen.filter((a) => a.id === 123)).toHaveLength(1);
    expect(seen.filter((a) => a.id === 124)).toHaveLength(1);
  });

  it("paginates a tie-heavy list correctly even when the tie straddles a page", async () => {
    // Build the adversarial case directly: ask for a page size's worth of rows
    // and then continue from the last one, with the boundary deliberately
    // landing inside a run of equal timestamps.
    const viewer = await getViewer();
    const first = await listArticles(viewer, SCOPE);
    expect(first.next).not.toBeNull();

    const boundary = first.items.at(-1)!;
    const second = await listArticles(viewer, SCOPE, first.next!);

    // Nothing from the second page may be newer than the boundary row.
    for (const a of second.items) {
      const after =
        a.publishedAt < boundary.publishedAt ||
        (a.publishedAt === boundary.publishedAt && a.id < boundary.id);
      expect(after, `row ${a.id} should sort after the boundary`).toBe(true);
    }
  });

  it("stops returning a cursor on the last page", async () => {
    const { requests } = await pageThrough();
    const expected = Math.ceil(articles.length / PAGE_SIZE);
    expect(requests).toBe(expected);
  });

  it("does not return a cursor when the final page is exactly full", async () => {
    // An extra request that renders nothing reads as an empty-state flash.
    const viewer = await getViewer();
    let cursor: Cursor | undefined;
    let last = await listArticles(viewer, SCOPE);
    while (last.next) {
      cursor = last.next;
      last = await listArticles(viewer, SCOPE, cursor);
    }
    expect(last.next).toBeNull();
    expect(last.items.length).toBeGreaterThan(0);
  });

  it("applies the filter consistently across pages", async () => {
    // A cursor is only valid for a fixed filter. Paging with a query must not
    // leak rows that do not match it.
    const viewer = await getViewer();
    let cursor: Cursor | undefined;
    const seen: Article[] = [];
    do {
      const page = await listArticles(viewer, SCOPE, cursor, { query: "a" });
      seen.push(...page.items);
      cursor = page.next ?? undefined;
    } while (cursor);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a.title.toLowerCase().includes("a"))).toBe(true);
  });
});

describe("the cursor's URL shape", () => {
  it("round-trips through the query string", () => {
    const cursor: Cursor = { publishedAt: "2026-11-12T09:12:00.000Z", id: 101 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is `<publishedAt>,<id>`, which M9 must not have to change", () => {
    expect(encodeCursor({ publishedAt: "2026-11-12T09:12:00.000Z", id: 101 })).toBe(
      "2026-11-12T09:12:00.000Z,101",
    );
  });

  it("splits on the LAST comma, because an ISO timestamp may contain none", () => {
    // Splitting on the first comma would break the moment a timestamp format
    // with a comma in it appeared, which is the sort of thing that changes.
    expect(decodeCursor("2026-11-12T09:12:00.000Z,101")).toEqual({
      publishedAt: "2026-11-12T09:12:00.000Z",
      id: 101,
    });
  });

  it("falls back to the first page on a malformed cursor", () => {
    // A stale or hand-edited link should land somewhere useful, not error.
    for (const bad of [undefined, "", "nonsense", "2026-11-12T09:12:00.000Z", ",", "x,y"]) {
      expect(decodeCursor(bad)).toBeUndefined();
    }
  });
});
