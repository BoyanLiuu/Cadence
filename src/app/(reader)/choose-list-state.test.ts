import { describe, expect, it } from "vitest";

import { feeds, subscriptions } from "@/lib/fixtures";
import type { Article, Folder, ListFeed, Page } from "@/lib/types";

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

/*
 * One subscribed feed as the LIST sees it — the projection `listFeedLabels`
 * returns, built here from the same fixture rows so the test and the service
 * agree about what a feed is called.
 *
 * It used to build a whole `SubscriptionWithUnread`; the chooser never read a
 * count, and asking for one made the list pane wait on two aggregate queries
 * per page click (see `ListFeed` in `types.ts`).
 */
const sub = (feedId: number): ListFeed => {
  const base = subscriptions.find((s) => s.feedId === feedId)!;
  const feed = feeds.find((f) => f.id === feedId)!;
  return {
    feedId,
    folderId: base.folderId,
    title: base.customTitle ?? feed.title,
    status: feed.status,
    nextFetchAt: feed.nextFetchAt,
    lastSuccessAt: feed.lastSuccessAt,
    notFeedAt: feed.notFeedAt ?? null,
    lastErrorAt: feed.lastError?.at ?? null,
  };
};

/** An empty page 1, which is the "nothing paged" starting point. */
const EMPTY: Page<Article> = { items: [], total: 0, page: 1, pages: 1 };

/** An empty page the reader asked for BY NUMBER — what "past the end" means now. */
const PAST_END: Page<Article> = { items: [], total: 120, page: 9, pages: 3 };

const base = (over: Partial<ChooseInput> = {}): ChooseInput => ({
  page: EMPTY,
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
    const page: Page<Article> = { items: [{ id: 1 } as Article], total: 1, page: 1, pages: 1 };
    expect(chooseListState(base({ page })).kind).toBe("rows");
  });

  it("returns rows on a later page with a query, which only matter when empty", () => {
    const page: Page<Article> = { items: [{ id: 1 } as Article], total: 120, page: 2, pages: 3 };
    expect(chooseListState(base({ page, query: "q" })).kind).toBe("rows");
  });
});

describe("asking for a page that is not there", () => {
  it("says the page does not exist rather than that everything is read", () => {
    // The bug, which outlived the cursor this now reads instead of: an empty
    // later page fell through to `all-read`, so `?page=9` rendered "Nothing
    // unread in any feed" beneath a heading saying "All unread / 81 unread".
    const state = chooseListState(base({ page: PAST_END, scopedSubs: [sub(1)] }));
    expect(state.kind).toBe("past-end");
  });

  it("applies in a folder view too", () => {
    const state = chooseListState(base({ page: PAST_END, folder: ESSAYS, scopedSubs: [sub(5)] }));
    expect(state.kind).toBe("past-end");
  });

  it("applies in a feed view too, rather than claiming the feed is empty", () => {
    const state = chooseListState(base({ page: PAST_END, currentSub: sub(1) }));
    expect(state.kind).toBe("past-end");
  });

  it("does NOT fire on an empty page 1, which is a genuinely empty view", () => {
    // The distinction the page number has to carry: page 1 empty means there
    // is nothing to read, and the reader should be told about the next check.
    const state = chooseListState(base({ scopedSubs: [sub(1)] }));
    expect(state.kind).not.toBe("past-end");
  });

  it("still lets a search explain itself first", () => {
    // A reader who searched and paged wants to know the search found nothing,
    // which is the more useful of the two facts.
    const state = chooseListState(base({ page: PAST_END, query: "lathe" }));
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
    const state = chooseListState(base({ currentSub: { ...s, notFeedAt: null } }));
    if (state.kind !== "not-a-feed") throw new Error("expected not-a-feed");
    expect(state.since).toBe(s.lastErrorAt);
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
