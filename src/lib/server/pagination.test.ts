import { describe, expect, it } from "vitest";

import { pageFromParam } from "@/components/article-list";
import { articles } from "@/lib/fixtures";
import { PAGE_SIZE, type Article, type Scope } from "@/lib/types";

import { listArticles } from "./article-service";
import { getViewer } from "./viewer";

/*
 * What this suite is for: the two classic pagination faults, caught while they
 * are still cheap.
 *
 *   1. A ROW ON TWO PAGES. The reader sees the same article twice and
 *      concludes the dedup is broken — the one thing this product cannot
 *      afford to look like.
 *   2. A ROW SKIPPED AT A PAGE BOUNDARY. Worse, because it is invisible: the
 *      article is simply never shown.
 *
 * IT WAS `keyset-cursor.test.ts`, AND THE RENAME IS THE POINT. The list used
 * to page with a `(publishedAt, id)` cursor, and §3 forbade `OFFSET` outright.
 * Numbered pages cannot be built on a cursor — jumping to page 4 means knowing
 * the fourth page's first row — so the list now uses `skip`/`take` and this
 * suite guards the same two faults against the new mechanism.
 *
 * WHICH MATTERS MORE NOW, not less. A cursor keyed on `(publishedAt, id)` was
 * immune to a tie by construction. `OFFSET` is not: two rows sharing a
 * `published_at` with no tie-break can swap between the two queries that fetch
 * page 1 and page 2, and then one of them appears twice and the other never.
 * The `orderBy` in both implementations is what prevents it, and these are the
 * assertions that notice if either one loses its second sort key.
 */

const SCOPE: Scope = { kind: "all" };

/** Walks every page in order, returning the rows and the number of requests. */
async function pageThrough(scope: Scope = SCOPE, filter?: { query: string }) {
  const viewer = await getViewer();
  const seen: Article[] = [];
  const first = await listArticles(viewer, scope, 1, filter);
  seen.push(...first.items);

  for (let page = 2; page <= first.pages; page += 1) {
    // A runaway loop is a bug in its own right; fail loudly rather than hang.
    if (page > 100) throw new Error("pagination did not terminate");
    const next = await listArticles(viewer, scope, page, filter);
    seen.push(...next.items);
  }

  return { seen, requests: first.pages, total: first.total };
}

describe("numbered pagination", () => {
  it("needs more than one page for this corpus, or it proves nothing", () => {
    expect(articles.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("never shows a row on two pages", async () => {
    const { seen } = await pageThrough();
    const ids = seen.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never skips a row at a page boundary", async () => {
    const { seen, total } = await pageThrough();
    // Every article in scope appears exactly once across all pages, and the
    // total the pager draws its buttons from agrees with what was handed over.
    expect(seen.length).toBe(articles.length);
    expect(total).toBe(articles.length);
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

  it("survives a tie on publishedAt, which is where OFFSET fails without a tie-break", async () => {
    // The corpus has a deliberate tie: 123 and 124 are the duplicate pair,
    // published at the same instant. Without the `id` tie-break their order is
    // undefined, so one of them appears on both pages and the other on none.
    const tied = articles.filter((a) => a.id === 123 || a.id === 124);
    expect(tied).toHaveLength(2);
    expect(tied[0].publishedAt).toBe(tied[1].publishedAt);

    const { seen } = await pageThrough();
    expect(seen.filter((a) => a.id === 123)).toHaveLength(1);
    expect(seen.filter((a) => a.id === 124)).toHaveLength(1);
  });

  it("reports a page count that matches the rows it will actually serve", async () => {
    const { requests, total } = await pageThrough();
    expect(requests).toBe(Math.ceil(total / PAGE_SIZE));
  });

  it("answers a page past the end with no rows, rather than the last page", async () => {
    // What `chooseListState` turns into "No such page". Clamping to the last
    // page instead would answer a reader's wrong URL with a right-looking
    // screen, and they would never learn the number was wrong.
    const viewer = await getViewer();
    const first = await listArticles(viewer, SCOPE, 1);
    const beyond = await listArticles(viewer, SCOPE, first.pages + 5);
    expect(beyond.items).toEqual([]);
    expect(beyond.page).toBe(first.pages + 5);
    expect(beyond.total).toBe(first.total);
  });

  it("clamps a zero or negative page to the first one", async () => {
    // `?page=0` and `?page=-3` are URLs anyone can send, and a negative
    // `skip` is a 500 rather than a page.
    const viewer = await getViewer();
    const first = await listArticles(viewer, SCOPE, 1);
    for (const bad of [0, -3]) {
      const page = await listArticles(viewer, SCOPE, bad);
      expect(page.page).toBe(1);
      expect(page.items.map((a) => a.id)).toEqual(first.items.map((a) => a.id));
    }
  });

  it("applies the filter consistently across pages", async () => {
    // A page number means nothing without the filter it counts into. Paging
    // with a query must not leak rows that do not match it.
    const { seen } = await pageThrough(SCOPE, { query: "a" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a.title.toLowerCase().includes("a"))).toBe(true);
  });
});

describe("the page number's URL shape", () => {
  it("reads a page number out of the query string", () => {
    expect(pageFromParam("4")).toBe(4);
    expect(pageFromParam("1")).toBe(1);
  });

  it("falls back to page 1 on anything that is not a page", () => {
    // A stale or hand-edited link lands somewhere useful rather than erroring.
    // `0` and `-2` are in here because they would become a negative `skip`,
    // and `012` because a non-canonical integer gives one page two URLs.
    for (const bad of [undefined, "", "nonsense", "0", "-2", "1.5", "012", "4abc"]) {
      expect(pageFromParam(bad), `"${bad}" should fall back`).toBe(1);
    }
  });
});
