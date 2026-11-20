import type { DiscoveryResult, Subscription, Tick, User } from "@/lib/types";

import { articles } from "./articles";
import { D, NOW, feeds, makeFolders } from "./feeds";

/*
 * The fixture corpus: a READ-ONLY typed module, not a store.
 *
 * Appendix C rule 1 — no localStorage, no IndexedDB, no reducer, no Zustand. A
 * local store would force every pane to `"use client"` and leave fake
 * persistence to unpick in phase 2. Everything here is frozen, so a component
 * that tries to mutate it fails loudly in development instead of appearing to
 * work and losing the write on reload.
 *
 * `hallmark/data.js` is the source. This module replaces it; neither it nor the
 * feed-body corpus M2 adds is deleted (Appendix C rule 5).
 */

export const SAMPLE_NOW = NOW;

/** The one fixture reader. M11 replaces this with the Clerk session. */
export const sampleUser: User = {
  // Shaped like a Clerk id because that is what the column holds (Appendix B).
  id: "user_2sampleElifBrandt",
  email: "elif@example.com",
  name: "Elif Brandt",
  initials: "EB",
  tz: "UTC",
  aiEnabled: false,
};

/*
 * Subscriptions carry what the prototype hung off the feed: the folder, the
 * title override and the date followed. A feed row is shared by every reader;
 * these three are one reader's own.
 */
const following: (Pick<Subscription, "feedId" | "folderId" | "subscribedAt"> &
  Partial<Subscription>)[] = [
  { feedId: 1, folderId: 1, subscribedAt: D("09-02T18:20") },
  { feedId: 2, folderId: 1, subscribedAt: D("09-02T18:24") },
  { feedId: 3, folderId: 1, subscribedAt: D("09-14T08:02") },
  { feedId: 4, folderId: 1, subscribedAt: D("10-01T12:40") },
  { feedId: 5, folderId: 2, subscribedAt: D("09-02T18:31") },
  { feedId: 6, folderId: 2, subscribedAt: D("09-20T21:10") },
  { feedId: 7, folderId: 2, subscribedAt: D("09-02T18:40") },
  { feedId: 8, folderId: 2, subscribedAt: D("09-02T18:44") },
  { feedId: 9, folderId: 3, subscribedAt: D("10-03T19:05") },
  // The changelog is the one feed that wants an edit to resurface (§6.2), and
  // the one with full text off, because its feed body is already complete.
  {
    feedId: 10,
    folderId: 3,
    subscribedAt: D("09-28T10:15"),
    resurfaceOnRevision: true,
    fullTextMode: "off",
  },
  { feedId: 11, folderId: 3, subscribedAt: D("11-11T15:02") },
  { feedId: 12, folderId: 3, subscribedAt: D("09-02T18:52") },
];

export const subscriptions: readonly Subscription[] = following.map((s) => ({
  userId: sampleUser.id,
  customTitle: null,
  fullTextMode: "on_demand",
  resurfaceOnRevision: false,
  ...s,
}));

/** The six most recent poll runs that fetched anything, grouped from `fetch_log`. */
export const ticks: readonly Tick[] = [
  { at: D("11-12T09:37"), ms: 900, work: [{ feedId: 1, code: 304 }] },
  {
    at: D("11-12T09:33"),
    ms: 1700,
    work: [{ feedId: 3, code: 200, note: "1 matched by address" }],
  },
  { at: D("11-12T09:30"), ms: 1400, work: [{ feedId: 10, code: 200, note: "1 revised" }] },
  {
    at: D("11-12T09:26"),
    ms: 2200,
    work: [{ feedId: 2, code: 200, note: "1 new, 2 matched by address" }],
  },
  { at: D("11-12T09:24"), ms: 10400, work: [{ feedId: 12, code: "timeout" }] },
  {
    at: D("11-12T09:22"),
    ms: 1900,
    work: [
      { feedId: 1, code: 200, note: "1 new" },
      { feedId: 7, code: 304 },
    ],
  },
];

/** §6.4: the per-invocation wall-clock budget, in ms. */
export const BUDGET_MS = 240_000;

/*
 * Canned `POST /api/feeds/discover` answers, for the sample addresses only.
 * Every candidate here is one the discoverer would have FETCHED and validated
 * before offering — which is what lets the add-feed screen state the format,
 * the item count and the last post before anyone subscribes (§6.3).
 */
export const discovery: Readonly<Record<string, DiscoveryResult>> = {
  "tidewaterletters.example": {
    kind: "found",
    candidates: [
      {
        title: "Tidewater Letters",
        feedUrl: "https://tidewaterletters.example/feed.atom",
        format: "atom",
        items: 24,
        lastPost: D("11-10T07:00"),
        intervalS: 86400,
        preview: [
          { title: "The pilot boat at slack water", at: D("11-10T07:00") },
          { title: "A chart with the soundings in fathoms", at: D("11-07T07:00") },
          { title: "Letters from the lock keeper's daughter", at: D("11-04T07:00") },
        ],
      },
      {
        title: "Tidewater Letters: comments",
        feedUrl: "https://tidewaterletters.example/comments/feed",
        format: "rss2",
        items: 50,
        lastPost: D("11-12T08:58"),
        intervalS: 1800,
        preview: [
          { title: 'On "The pilot boat at slack water"', at: D("11-12T08:58") },
          { title: 'On "The pilot boat at slack water"', at: D("11-12T08:12") },
          { title: 'On "A chart with the soundings in fathoms"', at: D("11-11T22:40") },
        ],
      },
    ],
  },
  "quarrylane.example/feed.json": {
    kind: "found",
    candidates: [
      {
        title: "Quarry Lane Letters",
        feedUrl: "https://quarrylane.example/feed.json",
        format: "json",
        items: 12,
        lastPost: D("11-09T12:00"),
        intervalS: 86400,
        preview: [
          { title: "Splitting slate along the grain", at: D("11-09T12:00") },
          { title: "The quarry pond in November", at: D("10-26T12:00") },
          { title: "A wall that has stood since 1840", at: D("10-12T12:00") },
        ],
      },
    ],
  },
  "hollowpinenotes.example": {
    kind: "found",
    candidates: [
      {
        title: "Hollow Pine Notes",
        feedUrl: "https://hollowpinenotes.example/journal/feed.xml",
        format: "rss2",
        items: 30,
        lastPost: D("11-09T16:00"),
        intervalS: 86400,
        preview: [
          { title: "The first snow on the ridge", at: D("11-09T16:00") },
          { title: "We moved the journal", at: D("11-02T16:00") },
          { title: "Closing the cabin for winter", at: D("10-20T16:00") },
        ],
      },
    ],
  },
  "brightwater-gazette.example": {
    kind: "found",
    candidates: [
      {
        title: "Brightwater Gazette",
        feedUrl: "https://brightwater-gazette.example/news/rss",
        format: "rss2",
        items: 20,
        lastPost: D("11-12T07:30"),
        intervalS: 21600,
        preview: [
          { title: "Bus timetable changes from Monday", at: D("11-12T07:30") },
          { title: "Pond on the green to be cleared", at: D("11-11T09:00") },
          { title: "Harvest fair returns to the green", at: D("11-08T12:00") },
        ],
      },
    ],
  },
  "harbourwire.example": { kind: "following", feedId: 1 },
  "plainpage.example": {
    kind: "none",
    reason: "The page links no feed, and /feed, /rss and /atom.xml aren't feeds either.",
  },
  "slowhost.example": { kind: "unreachable", reason: "It didn't answer within 10 seconds." },
};

export const SAMPLE_ADDRESSES = [
  "tidewaterletters.example",
  "quarrylane.example/feed.json",
  "harbourwire.example",
  "plainpage.example",
  "slowhost.example",
];

/** A feed another reader follows, so it exists but is not in this reader's list. */
export const unfollowed = {
  id: 41,
  title: "Tidewater Letters",
  siteUrl: "https://tidewaterletters.example",
};

/*
 * This reader's folders, plus ONE belonging to somebody else.
 *
 * The foreign row is deliberate and it is load-bearing. Folders are per-user
 * (Appendix D), so a read that forgets to scope by `userId` is correct while
 * every row belongs to one reader and leaks the moment M11 adds a second. With
 * a foreign row in the corpus, `listFolders` returning `[...folders]` fails a
 * test instead of passing until production. Nothing subscribes into it.
 */
export const folders = [
  ...makeFolders(sampleUser.id),
  { id: 90, userId: "user_2someoneElse", name: "Someone else's folder", position: 0 },
];

export { articles, feeds, D };

/*
 * Frozen deeply, so "read-only" is enforced rather than documented. A pane that
 * pushes onto `articles` throws here instead of silently working in dev and
 * losing the change on the next request.
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

deepFreeze(folders);
deepFreeze(feeds);
deepFreeze(articles);
deepFreeze(subscriptions);
deepFreeze(ticks);
deepFreeze(discovery);
deepFreeze(sampleUser);
