import { describe, expect, it } from "vitest";

import { articles } from "@/lib/fixtures";

import { listArticles } from "./article-service";
import { getViewer } from "./viewer";

/*
 * What this suite is for: Saved borrowing the unread list's empty copy.
 *
 * The plan takes this from Readwise Reader: Saved is a different product
 * surface, not a filter on the unread river. The empty state is where that
 * distinction is cheapest to get wrong and most obviously wrong once seen —
 * the reader's copy is "Nothing unread in any feed. Feeds are checked on their
 * own schedules. The next is Harbour Wire, at 09:52." Every clause of that is
 * false of an empty Saved: it is not about unread, not about feeds, and not
 * waiting for a schedule. It is waiting for the reader to save something.
 *
 * The page's own rendering is asserted in the component test beside it; this
 * pins the SCOPE the page is built on, because an empty Saved is only
 * trustworthy if `{kind:"saved"}` really means "savedAt is not null".
 */

describe("the saved scope", () => {
  it("returns only saved articles", async () => {
    const viewer = await getViewer();
    const page = await listArticles(viewer, { kind: "saved" });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((a) => a.savedAt !== null)).toBe(true);
  });

  it("includes saved articles that are already READ", async () => {
    // The sharpest difference from the unread river. An article you saved and
    // finished still belongs in Saved — filtering on unread would silently
    // empty the surface for anyone who reads what they save.
    const viewer = await getViewer();
    const page = await listArticles(viewer, { kind: "saved" });
    expect(page.items.some((a) => a.readAt !== null)).toBe(true);
  });

  it("includes saved articles that are unread", async () => {
    const viewer = await getViewer();
    const page = await listArticles(viewer, { kind: "saved" });
    expect(page.items.some((a) => a.readAt === null)).toBe(true);
  });

  it("is not the same set as the unread scope", async () => {
    const viewer = await getViewer();
    const saved = await listArticles(viewer, { kind: "saved" });
    const unread = await listArticles(viewer, { kind: "unread" });
    const savedIds = new Set(saved.items.map((a) => a.id));
    const unreadIds = new Set(unread.items.map((a) => a.id));
    expect(savedIds).not.toEqual(unreadIds);
  });

  it("returns an empty page for a reader with nothing saved", async () => {
    // The corpus always has saved articles, so the empty case is constructed:
    // it must be an empty page rather than an error or a fallback to unread.
    const viewer = await getViewer();
    const page = await listArticles(viewer, { kind: "saved" }, undefined, {
      query: "zzz-nothing-matches-this",
    });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.pages).toBe(1);
  });

  it("has a fixture saved article in the corpus at all", () => {
    // Without one, every Saved screen renders its empty state and the real
    // surface is never seen — the gap M1's fixture test exists to prevent.
    expect(articles.some((a) => a.savedAt !== null)).toBe(true);
  });
});
