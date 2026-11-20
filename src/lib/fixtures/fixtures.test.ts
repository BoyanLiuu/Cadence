import { describe, expect, it } from "vitest";

import { PAGE_SIZE, type ExtractStatus, type FeedStatus } from "@/lib/types";

import { articles, feeds, folders, subscriptions } from "./index";

/*
 * What this suite is for: a fixture set that cannot exercise the UI.
 *
 * The bug it catches is specific and it is expensive. If no fixture reaches a
 * state, the screen for that state has no data, renders blank, and looks
 * finished — and the gap surfaces two phases later when there is a database to
 * blame instead of a corpus. Every assertion below corresponds to a screen that
 * would otherwise be empty.
 */

describe("the fixture corpus can exercise every screen", () => {
  it("has a feed in all four terminal and running states", () => {
    // ux-35 to ux-37 are the failing, stopped and no-longer-a-feed screens.
    const wanted: FeedStatus[] = ["active", "backoff", "dead", "not_a_feed"];
    const present = new Set(feeds.map((f) => f.status));
    expect([...wanted].filter((s) => !present.has(s))).toEqual([]);
  });

  it("has an article in all five extract states", () => {
    // 'thin' and 'blocked' have their own copy in §6.5; without a row each,
    // neither message is ever rendered.
    const wanted: ExtractStatus[] = ["none", "ok", "thin", "blocked", "failed"];
    const present = new Set(articles.map((a) => a.extractStatus));
    expect([...wanted].filter((s) => !present.has(s))).toEqual([]);
  });

  it("has a revised article that is still read", () => {
    // The whole of §6.2 in one row: an edit must not un-read what was read.
    const revised = articles.filter((a) => a.revisedAt !== null);
    expect(revised.length).toBeGreaterThan(0);
    expect(revised.some((a) => a.readAt !== null)).toBe(true);
  });

  it("has a feed whose guids are known to be unstable", () => {
    const unstable = feeds.filter((f) => f.guidUnstable);
    expect(unstable.length).toBeGreaterThan(0);
    // The learned flag must come with the evidence that produced it: a log
    // whose collapses are by URL, not by guid (§6.1).
    expect(unstable[0].today.mergedByUrl).toBeGreaterThan(0);
    expect(unstable[0].today.mergedByGuid).toBe(0);
  });

  it("has a new feed still on probation, so the rung-2 pre-check has a case", () => {
    expect(feeds.some((f) => f.cleanPolls !== null && f.cleanPolls < 3)).toBe(true);
  });

  it("has a visible duplicate pair for the manual merge", () => {
    // Same feed, same publish time, near-identical title: the case no rung
    // catches, which is why the merge exists (§6.1).
    const pair = articles.filter((a) => a.id === 123 || a.id === 124);
    expect(pair).toHaveLength(2);
    expect(pair[0].feedId).toBe(pair[1].feedId);
    expect(pair[0].publishedAt).toBe(pair[1].publishedAt);
    expect(pair[0].url).not.toBe(pair[1].url);
  });

  it("has a folder tree with every subscription filed in it", () => {
    expect(folders.length).toBeGreaterThan(1);
    const ids = new Set(folders.map((f) => f.id));
    for (const s of subscriptions) {
      if (s.folderId !== null) expect(ids.has(s.folderId)).toBe(true);
    }
  });

  it("exceeds one page, so pagination is exercised rather than assumed", () => {
    expect(articles.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("has a saved article and an unread one, so neither surface is empty", () => {
    expect(articles.some((a) => a.savedAt !== null)).toBe(true);
    expect(articles.some((a) => a.readAt === null)).toBe(true);
  });
});

describe("the corpus is ordered and keyed for keyset pagination", () => {
  it("is newest first", () => {
    for (let i = 1; i < articles.length; i += 1) {
      expect(articles[i - 1].publishedAt >= articles[i].publishedAt).toBe(true);
    }
  });

  it("has no duplicate ids", () => {
    expect(new Set(articles.map((a) => a.id)).size).toBe(articles.length);
  });

  it("never repeats a (publishedAt, id) pair", () => {
    // The keyset cursor is that pair. A collision is how a page boundary
    // silently drops or repeats a row.
    const keys = articles.map((a) => `${a.publishedAt}#${a.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("points every article at a feed that exists", () => {
    const ids = new Set(feeds.map((f) => f.id));
    const orphans = articles.filter((a) => !ids.has(a.feedId)).map((a) => a.id);
    expect(orphans).toEqual([]);
  });
});

describe("the corpus is read-only", () => {
  it("refuses a push", () => {
    // Appendix C rule 1: fixtures are a module, not a store. Frozen so an
    // attempted write fails here rather than appearing to work in dev.
    expect(() => (articles as unknown as unknown[]).push({})).toThrow();
  });

  it("refuses a field write", () => {
    expect(() => {
      (articles[0] as unknown as Record<string, unknown>).title = "mutated";
    }).toThrow();
  });
});
