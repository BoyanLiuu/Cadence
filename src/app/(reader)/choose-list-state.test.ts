import { describe, expect, it } from "vitest";

import { feeds, subscriptions } from "@/lib/fixtures";
import type { Article, Folder, SubscriptionWithUnread } from "@/lib/types";

import { chooseListState, type ChooseInput } from "./choose-list-state";

/*
 * What this suite is for: an empty list explaining itself WRONGLY.
 *
 * Every branch here renders a page that looks finished, which is why two of
 * M4's review findings lived in this logic and neither was visible in a
 * screenshot. The failures are all of one kind — the reader is told something
 * true-sounding and false:
 *
 *   - "Nothing unread in any feed" when they had merely paged past the end,
 *     printed under a heading reading "All unread / 81 unread";
 *   - "The next is Harbour Wire" in a folder that does not contain it.
 *
 * Both were unreachable from a component test, because the choosing happened
 * inside an async Server Component.
 */

const sub = (feedId: number, unread = 0): SubscriptionWithUnread => {
  const base = subscriptions.find((s) => s.feedId === feedId)!;
  const feed = feeds.find((f) => f.id === feedId)!;
  return { ...base, feed, unread };
};

const base = (over: Partial<ChooseInput> = {}): ChooseInput => ({
  page: { items: [], next: null },
  cursor: undefined,
  query: "",
  unreadOnly: true,
  currentSub: undefined,
  folder: undefined,
  scopedSubs: [],
  feedTitleOf: (id) => feeds.find((f) => f.id === id)?.title ?? `Feed ${id}`,
  ...over,
});

const ESSAYS: Folder = { id: 2, userId: "u", name: "Essays", position: 1 };

describe("rows win over every empty state", () => {
  it("returns rows when the page has any", () => {
    const page = { items: [{ id: 1 } as Article], next: null };
    expect(chooseListState(base({ page })).kind).toBe("rows");
  });

  it("returns rows even with a cursor and a query, which only matter when empty", () => {
    const page = { items: [{ id: 1 } as Article], next: null };
    const state = chooseListState(base({ page, cursor: { publishedAt: "x", id: 1 }, query: "q" }));
    expect(state.kind).toBe("rows");
  });
});

describe("paging past the end", () => {
  it("says nothing is OLDER rather than that everything is read", () => {
    // The bug: this fell through to `all-read`, so `/?before=<old cursor>`
    // rendered "Nothing unread in any feed" beneath "All unread / 81 unread".
    const state = chooseListState(
      base({ cursor: { publishedAt: "2000-01-01T00:00:00Z", id: 1 }, scopedSubs: [sub(1, 13)] }),
    );
    expect(state.kind).toBe("past-end");
  });

  it("applies in a folder view too", () => {
    const state = chooseListState(
      base({
        cursor: { publishedAt: "2000-01-01T00:00:00Z", id: 1 },
        folder: ESSAYS,
        scopedSubs: [sub(5, 9)],
      }),
    );
    expect(state.kind).toBe("past-end");
  });

  it("applies in a feed view too, rather than claiming the feed is empty", () => {
    const state = chooseListState(
      base({ cursor: { publishedAt: "2000-01-01T00:00:00Z", id: 1 }, currentSub: sub(1, 13) }),
    );
    expect(state.kind).toBe("past-end");
  });

  it("still lets a search explain itself first", () => {
    // A reader who searched and paged wants to know the search found nothing,
    // which is the more useful of the two facts.
    const state = chooseListState(base({ cursor: { publishedAt: "x", id: 1 }, query: "lathe" }));
    expect(state.kind).toBe("no-matches");
  });
});

describe("the next check comes from the scoped feeds", () => {
  it("names a feed inside the folder, not merely the soonest overall", () => {
    // The bug: this read every subscription, so the Essays view announced
    // "The next is Harbour Wire" — a feed in News.
    const state = chooseListState(base({ folder: ESSAYS, scopedSubs: [sub(5), sub(6), sub(7)] }));
    expect(state.kind).toBe("all-read");
    if (state.kind !== "all-read") return;
    expect(["The Fenwick Review", "Marginalia Weekly", "Orchard Street Journal"]).toContain(
      state.nextFetch?.title,
    );
    expect(state.nextFetch?.title).not.toBe("Harbour Wire");
  });

  it("picks the soonest of the scoped feeds", () => {
    const state = chooseListState(base({ scopedSubs: [sub(5), sub(1)] }));
    if (state.kind !== "all-read") throw new Error("expected all-read");
    // Feed 1 is next at 09:52; feed 5 not until the following day.
    expect(state.nextFetch?.title).toBe("Harbour Wire");
  });

  it("skips a feed with no next check, because a dead feed has none", () => {
    // Feed 8 is dead and feed 4 is not_a_feed; both have `nextFetchAt: null`.
    const state = chooseListState(base({ scopedSubs: [sub(8), sub(4)] }));
    if (state.kind !== "all-read") throw new Error("expected all-read");
    expect(state.nextFetch).toBeNull();
  });

  it("reports no next check rather than inventing one when nothing is scheduled", () => {
    const state = chooseListState(base({ scopedSubs: [] }));
    if (state.kind !== "all-read") throw new Error("expected all-read");
    expect(state.nextFetch).toBeNull();
  });
});

describe("a feed that is no longer a feed", () => {
  it("beats the generic empty-feed state", () => {
    // §6.3's most common user-reported failure. "Nothing here yet" would read
    // as a quiet week rather than as a broken address.
    const state = chooseListState(base({ currentSub: sub(4) }));
    expect(state.kind).toBe("not-a-feed");
    if (state.kind !== "not-a-feed") return;
    expect(state.feedTitle).toBe("Brightwater Gazette");
    // ISO instants; the component formats them.
    expect(state.since).toMatch(/^2026-/);
    expect(state.lastGood).toMatch(/^2026-/);
  });

  it("falls back to the error timestamp when notFeedAt is absent", () => {
    const s = sub(4);
    const state = chooseListState(
      base({ currentSub: { ...s, feed: { ...s.feed, notFeedAt: undefined } } }),
    );
    if (state.kind !== "not-a-feed") throw new Error("expected not-a-feed");
    expect(state.since).toBe(s.feed.lastError?.at);
  });

  it("does not claim not-a-feed for a merely failing feed", () => {
    // Feed 12 is in backoff: it is still a feed, and still being retried.
    const state = chooseListState(base({ currentSub: sub(12) }));
    expect(state.kind).toBe("feed-empty");
  });
});

describe("the remaining cases", () => {
  it("an empty feed says it has been checked", () => {
    const state = chooseListState(base({ currentSub: sub(11) }));
    expect(state.kind).toBe("feed-empty");
    if (state.kind !== "feed-empty") return;
    expect(state.feedTitle).toBe("Kestrel Field Notes");
  });

  it("an empty All-articles view names the folder it is in", () => {
    const state = chooseListState(base({ unreadOnly: false, folder: ESSAYS }));
    expect(state.kind).toBe("feed-empty");
    if (state.kind !== "feed-empty") return;
    expect(state.feedTitle).toBe("Essays");
  });

  it("an empty All-articles view with no folder still says something", () => {
    const state = chooseListState(base({ unreadOnly: false }));
    expect(state.kind).toBe("feed-empty");
  });

  it("never returns rows when the page is empty", () => {
    // The one invariant across every branch: an empty page always gets an
    // explanation, never a blank list.
    for (const over of [
      {},
      { cursor: { publishedAt: "x", id: 1 } },
      { query: "q" },
      { currentSub: sub(1) },
      { folder: ESSAYS },
      { unreadOnly: false },
    ]) {
      expect(chooseListState(base(over)).kind).not.toBe("rows");
    }
  });
});
