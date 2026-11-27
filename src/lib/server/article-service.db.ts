import { prisma } from "@/lib/db/client";
import {
  EMPTY_TODAY,
  toArticle,
  toFeed,
  toFetchLogEntry,
  toFolder,
  toSubscription,
  type TodayCounters,
} from "@/lib/db/map";
import {
  PAGE_SIZE,
  type Article,
  type Cursor,
  type FetchLogEntry,
  type Folder,
  type ListFilter,
  type Page,
  type Scope,
  type SubscriptionWithUnread,
  type Tick,
  type Viewer,
} from "@/lib/types";

import { assertCan, requireUser } from "./viewer";

/*
 * The data access boundary (ARCHITECTURE Appendix C) — POSTGRES implementation.
 *
 * Signature-for-signature identical to `article-service.fixtures.ts`, which is
 * the entire point of M1 having written the signatures before any database
 * existed: no component moved and no caller changed shape to get here.
 *
 * Two properties are load-bearing rather than stylistic:
 *
 *  - EVERY READ IS SCOPED BY THE SESSION'S USER, with an explicit filter. RLS
 *    is enabled with no policies as defence in depth, but the role Prisma
 *    connects as owns the tables and bypasses it — so RLS is the backstop and
 *    these filters are the authorization model (§3).
 *  - NEVER `OFFSET`. Keyset only, ordered on `(published_at, id)`.
 *    `no-offset.test.ts` fails the build if the word appears in this directory.
 */

/** This reader's subscribed feed ids. */
async function subscribedFeedIds(userId: string): Promise<bigint[]> {
  const rows = await prisma.subscription.findMany({
    where: { userId },
    select: { feedId: true },
  });
  return rows.map((r) => r.feedId);
}

/** Midnight UTC today, which is what "since 00:00 UTC" on the health screen means. */
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Today's counters per feed, derived from `fetch_log`.
 *
 * NOT stored on the feed. §6.2: `fetch_log` is the only evidence dedup is
 * working, and a denormalised copy of these numbers would be a second place
 * for them to be wrong. One grouped aggregate over a day of rows is cheap;
 * the index is `(feed_id, at DESC)`.
 */
async function todayByFeed(feedIds: bigint[]): Promise<Map<string, TodayCounters>> {
  if (feedIds.length === 0) return new Map();

  const rows = await prisma.fetchLog.groupBy({
    by: ["feedId"],
    where: { feedId: { in: feedIds }, at: { gte: startOfUtcDay() } },
    _count: { _all: true },
    _sum: {
      itemsSeen: true,
      itemsNew: true,
      mergedByGuid: true,
      mergedByUrl: true,
      mergedByContent: true,
      revised: true,
      guidAgreed: true,
      guidChurned: true,
    },
  });

  // A 304 is a SUCCESS, not an absence of one (§6.4), so it is counted
  // separately rather than inferred from "no items".
  const notModified = await prisma.fetchLog.groupBy({
    by: ["feedId"],
    where: { feedId: { in: feedIds }, at: { gte: startOfUtcDay() }, statusCode: 304 },
    _count: { _all: true },
  });
  // A failure is EITHER a transport outcome with no status (timeout, parse) OR
  // an HTTP status of 400 and up. Counting only `errorCode` treated every 404,
  // 429 and 503 as a success, so feed 12's five failures came out as four.
  const failed = await prisma.fetchLog.groupBy({
    by: ["feedId"],
    where: {
      feedId: { in: feedIds },
      at: { gte: startOfUtcDay() },
      OR: [{ errorCode: { not: null } }, { statusCode: { gte: 400 } }],
    },
    _count: { _all: true },
  });

  const n304 = new Map(notModified.map((r) => [String(r.feedId), r._count._all]));
  const nFailed = new Map(failed.map((r) => [String(r.feedId), r._count._all]));

  return new Map(
    rows.map((r) => [
      String(r.feedId),
      {
        checks: r._count._all,
        n304: n304.get(String(r.feedId)) ?? 0,
        failed: nFailed.get(String(r.feedId)) ?? 0,
        seen: r._sum.itemsSeen ?? 0,
        new: r._sum.itemsNew ?? 0,
        mergedByGuid: r._sum.mergedByGuid ?? 0,
        mergedByUrl: r._sum.mergedByUrl ?? 0,
        mergedByContent: r._sum.mergedByContent ?? 0,
        revised: r._sum.revised ?? 0,
        guidAgreed: r._sum.guidAgreed ?? 0,
        guidChurned: r._sum.guidChurned ?? 0,
      },
    ]),
  );
}

/**
 * The sidebar: folders, feeds, and a DERIVED unread count.
 *
 * The count is `count(*) WHERE read_at IS NULL`, served by the partial index
 * `ua_unread` — never a stored column before P2, because a counter that drifts
 * is worse than a 15 ms count and this is the number the product's credibility
 * rests on (§6.2).
 *
 * A MISSING `user_articles` row means unread, so the count cannot be a join
 * onto that table: it is articles-in-the-feed minus articles-this-reader-has-
 * read. Counting present rows would report 0 unread for a feed nobody has
 * touched.
 */
export async function listSubscriptions(viewer: Viewer): Promise<SubscriptionWithUnread[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  const subs = await prisma.subscription.findMany({
    where: { userId: user.id },
    include: { feed: { include: { fetchLog: { orderBy: { at: "desc" }, take: 8 } } } },
    orderBy: { feedId: "asc" },
  });

  const feedIds = subs.map((s) => s.feedId);

  /*
   * TWO QUERIES, ONE ROUND TRIP OF WAITING — the same defect `reader-view.tsx`
   * fixed in the view layer, one layer down and costing more.
   *
   * This function was three sequential `await`s: the subscriptions, then
   * today's counters, then the unread counts. The last two both need `feedIds`
   * from the first and NEITHER needs the other, so the third round trip was
   * pure queueing. Measured against the remote pooler: 900 ms for the three,
   * ~600 ms once these two overlap.
   *
   * It matters more here than anywhere else in the project because this is the
   * SIDEBAR's query, awaited before the reader's shell renders at all — so
   * every millisecond is one the whole screen waits for, on every navigation.
   */
  const [today, unreadRows] = await Promise.all([
    todayByFeed(feedIds),
    /*
     * The unread count, as §6.2's query rather than as arithmetic.
     *
     * Written raw and deliberately. Two things were wrong with computing it as
     * "articles in the feed minus articles this reader has read":
     *
     *  - It materialised EVERY article id the reader had ever read and sent
     *    them back as an `IN (...)` list. That grows without bound and breaks
     *    outright past Postgres' 65,535 bind-parameter limit — on the sidebar
     *    query, which runs on every render.
     *  - It asked the COMPLEMENT of what `ua_unread` indexes. That index is
     *    partial on `read_at IS NULL`, so a query about rows where `read_at` is
     *    NOT null can never use it, and the one index Appendix D added for this
     *    count was dead weight.
     *
     * The LEFT JOIN below is §6.2 verbatim: a MISSING `user_articles` row means
     * unread, which is why it cannot be an inner join and why rows are written
     * lazily (§6.2).
     *
     * TABLES ARE SCHEMA-QUALIFIED. Prisma's generated queries know about
     * `schemas = ["cadence"]`, but `$queryRaw` is passed through verbatim — and
     * `?schema=` is a Prisma concept the `pg` driver ignores, so the runtime
     * connection's `search_path` is Supabase's default `public, extensions`.
     * Unqualified, this query looks for `public.articles` and fails. Verified
     * by connecting, which is the only way this was ever going to surface.
     *
     * Grouped by the ARRIVING feed, not by `articles.feed_id`. Rung 2 is
     * global, so a story through two feeds is one row owned by the first.
     * Counting on `a.feed_id` credited that whole row to the first feed and
     * gave the second a zero — so a sidebar badge said 0 unread next to a feed
     * whose list had unread articles in it. `article_feeds` is what makes the
     * badge agree with the list it labels.
     */
    prisma.$queryRaw<{ feed_id: bigint; unread: bigint }[]>`
      SELECT af.feed_id, count(*) AS unread
      FROM cadence.article_feeds af
      JOIN cadence.articles a ON a.id = af.article_id
      LEFT JOIN cadence.user_articles ua
        ON ua.article_id = a.id AND ua.user_id = ${user.id}
      WHERE af.feed_id = ANY(${feedIds}::bigint[])
        AND ua.read_at IS NULL
      GROUP BY af.feed_id
    `,
  ]);

  const unreadByFeed = new Map(unreadRows.map((r) => [String(r.feed_id), Number(r.unread)]));

  return subs.map((s) => {
    const key = String(s.feedId);
    return {
      ...toSubscription(s),
      feed: toFeed(s.feed, today.get(key) ?? EMPTY_TODAY, s.feed.fetchLog.map(toFetchLogEntry)),
      unread: unreadByFeed.get(key) ?? 0,
    };
  });
}

/** The folder tree, scoped to the reader who filed them. */
export async function listFolders(viewer: Viewer): Promise<Folder[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  const rows = await prisma.folder.findMany({
    where: { userId: user.id },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map(toFolder);
}

/** The recent ticks and the per-invocation budget (§6.4). */
export async function listTicks(viewer: Viewer): Promise<Tick[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  /*
   * Grouped by the minute they ran in: one tick is one `POST /api/cron/poll`
   * invocation, and it may touch several feeds.
   *
   * Scoped to THIS reader's subscriptions, like every other read. Without the
   * join it reported ticks for feeds the reader does not follow, leaking other
   * readers' feed ids the moment M11 adds a second account — and `getFeedHealth`
   * directly below already did it correctly, which made the omission worse.
   */
  const rows = await prisma.fetchLog.findMany({
    where: { feed: { subscriptions: { some: { userId: user.id } } } },
    orderBy: { at: "desc" },
    take: 40,
    select: {
      at: true,
      feedId: true,
      statusCode: true,
      errorCode: true,
      itemsNew: true,
      mergedByUrl: true,
      revised: true,
    },
  });

  const byMinute = new Map<string, Tick>();
  for (const row of rows) {
    const minute = row.at.toISOString().slice(0, 16);
    const existing = byMinute.get(minute);
    const entry = toFetchLogEntry({
      ...row,
      itemsSeen: 0,
      mergedByGuid: 0,
      mergedByContent: 0,
      note: null,
    });
    const work = { feedId: Number(row.feedId), code: entry.code };
    if (existing) {
      existing.work.push(work);
    } else {
      byMinute.set(minute, { at: row.at.toISOString(), work: [work] });
    }
  }

  return [...byMinute.values()].slice(0, 6);
}

/**
 * The where-clause for a scope, scoped to this reader's subscriptions.
 *
 * EVERY case matches on ARRIVALS (`article_feeds`), not on `articles.feed_id`.
 *
 * Rung 2 is global (§6.1), so one story through two feeds is ONE row, owned by
 * whichever feed got there first. `articles.feed_id` names that first feed and
 * nothing else — so a filter on it hides the article from every OTHER feed
 * carrying it. For a reader subscribed to the second feed but not the first,
 * that means the article is missing from their list entirely.
 *
 * Which is precisely the cost Appendix G question 2 names: collapsing is
 * correct, but it "can read as an article going missing". Appendix E answers the
 * cosmetic half with the "also in 2 feeds" panel; this answers the half that
 * is not cosmetic.
 *
 * Authorization rides on the SAME relation: the subscription is checked on the
 * arriving feed, so a reader only ever sees arrivals through feeds they follow.
 * RLS is bypassed by the owning role, which makes this filter the
 * authorization model rather than a convenience (§3).
 */
function scopeWhere(scope: Scope, feedIds: bigint[], userId: string) {
  /*
   * Subscribed arrivals. `feedIds` is already this reader's subscribed feeds,
   * so matching the arrival against that set is both the scope AND the
   * permission check.
   */
  const base = { arrivals: { some: { feedId: { in: feedIds } } } };
  const unread = { userArticles: { none: { userId, readAt: { not: null } } } };

  switch (scope.kind) {
    case "unread":
      return { ...base, ...unread };
    case "all":
      return base;
    case "saved":
      return { ...base, userArticles: { some: { userId, savedAt: { not: null } } } };
    case "feed":
      /*
       * ONE relation filter carrying both conditions, not two.
       *
       * The arriving feed must be the scoped feed AND one the reader follows.
       * Splitting those — an arrival filter plus a separate
       * `feed: { subscriptions: ... }` — checks the subscription against the
       * OWNING feed instead, which gets it wrong in both directions: it hides
       * an article the reader's own feed carries but another feed owns, and it
       * reveals that an unsubscribed feed carries one they can already see.
       *
       * An earlier version of this case had a related bug: it spread a `base`
       * containing nothing but `feedId` and then set `feedId` on the next
       * line, so the spread was overwritten and the subscription filter its
       * comment claimed did not exist. `scopes-authorization.test.ts`
       * constructs the case that catches it — all twelve fixture feeds belong
       * to the one fixture user, so nothing else distinguishes "subscribed"
       * from "exists".
       */
      return {
        arrivals: {
          some: {
            feedId: BigInt(scope.feedId),
            feed: { subscriptions: { some: { userId } } },
          },
        },
        ...(scope.unreadOnly ? unread : {}),
      };
    case "folder":
      // The subscription relation carries BOTH the folder and the owner, so
      // this needs no separate `base` — and cannot be overwritten by it.
      return {
        arrivals: {
          some: { feed: { subscriptions: { some: { userId, folderId: BigInt(scope.folderId) } } } },
        },
        ...(scope.unreadOnly ? unread : {}),
      };
    default: {
      /*
       * THROWS, and this is not defensive decoration — it is a hole that was
       * open. Without a default the function returned `undefined` for an
       * unrecognised scope, Prisma read `where: undefined` as NO FILTER, and
       * every article in the database matched: other readers' feeds included.
       *
       * Harmless while only reads used this and every caller passed a literal.
       * `markScopeRead` changed that — it takes a scope from a CLIENT and
       * writes, so `{}` marked a reader's entire history read, across feeds
       * they do not follow. A generic test calling every mutation with `1` as
       * its argument did exactly that, to the seeded corpus.
       *
       * `never` makes an unhandled kind a compile error too, so the next scope
       * added cannot reach this at all.
       */
      const unreachable: never = scope;
      throw new Error(`Unknown scope: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The `where` that selects the articles one reader sees in one view.
 *
 * EXPORTED SO THERE IS ONE COPY. "Mark all read" has to mark exactly the
 * articles the list is showing, which means the same subscription relation, the
 * same scope rules AND the same title filter — a second implementation of that
 * is how a read filter and a write filter drift apart, with the write being the
 * one that matters.
 *
 * THE FILTER IS PART OF THE VIEW, not a refinement of it. Omitting it was a
 * real bug: search "rust", see three rows, press the button, and every unread
 * article in the scope was marked read. The reader asked about what was in
 * front of them.
 *
 * `null` means the reader follows nothing, so no article is in scope at all —
 * distinct from an empty `where`, which matches everything.
 */
export async function scopedArticleWhere(userId: string, scope: Scope, filter?: ListFilter) {
  const feedIds = await subscribedFeedIds(userId);
  if (feedIds.length === 0) return null;

  const query = filter?.query?.trim();
  return {
    ...scopeWhere(scope, feedIds, userId),
    ...(query ? { title: { contains: query, mode: "insensitive" as const } } : {}),
  };
}

/**
 * One page of articles, newest first, ordered on `(publishedAt, id)`.
 *
 * KEYSET, never `OFFSET` (§3, N6). The cursor is the last row of the previous
 * page rather than a row count, so an article arriving mid-read cannot
 * duplicate or skip a row. Served by `articles_feed_time`.
 */

export async function listArticles(
  viewer: Viewer,
  scope: Scope,
  cursor?: Cursor,
  filter?: ListFilter,
): Promise<Page<Article>> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const feedIds = await subscribedFeedIds(user.id);
  if (feedIds.length === 0) return { items: [], next: null };

  const query = filter?.query?.trim();

  const rows = await prisma.article.findMany({
    where: {
      ...scopeWhere(scope, feedIds, user.id),
      ...(query ? { title: { contains: query, mode: "insensitive" as const } } : {}),
      ...(cursor
        ? {
            OR: [
              { publishedAt: { lt: new Date(cursor.publishedAt) } },
              {
                publishedAt: new Date(cursor.publishedAt),
                id: { lt: BigInt(cursor.id) },
              },
            ],
          }
        : {}),
    },
    include: {
      userArticles: { where: { userId: user.id } },
      /*
       * Loaded with the page, not per row.
       *
       * Two things need it. Appendix E's "also in 2 feeds" panel is the stated reason
       * `article_feeds` exists. And the row's own label: the list now matches
       * on arrivals, so an article can appear under a feed the reader follows
       * while `articles.feed_id` names one they do not — and labelling it from
       * `feed_id` rendered "Unknown feed".
       */
      arrivals: { orderBy: [{ firstSeenAt: "asc" }, { feedId: "asc" }] },
    },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    // One extra row, to learn whether a further page exists without a second
    // COUNT — and without returning a cursor on a full final page, which costs
    // an empty request and an empty-state flash.
    take: PAGE_SIZE + 1,
  });

  const items = rows
    .slice(0, PAGE_SIZE)
    .map((r) => toArticle(r, r.userArticles[0] ?? null, r.arrivals));
  const last = items.at(-1);
  const next =
    last && rows.length > PAGE_SIZE ? { publishedAt: last.publishedAt, id: last.id } : null;

  return { items, next };
}

/**
 * DISTINCT unread articles in a scope.
 *
 * A query rather than a sum over the sidebar's per-feed badges, and the
 * difference is not cosmetic. Rung 2 is global (§6.1), so one story carried by
 * two subscribed feeds is ONE article with TWO arrivals: each feed's badge
 * counts it, correctly, and adding those badges up counts it twice. The header
 * then reads "2 unread" above a list holding one row — the unread count lying,
 * which is the one number §6.1 says the product's credibility rests on.
 *
 * This counts ARTICLE rows and the arrival filter is an `EXISTS`, so it is
 * distinct by construction — two arrivals cannot make one article count twice.
 * That is the whole reason it is a query over articles rather than a sum over
 * feeds.
 */
export async function countUnread(viewer: Viewer, scope: Scope): Promise<number> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const feedIds = await subscribedFeedIds(user.id);
  if (feedIds.length === 0) return 0;

  return prisma.article.count({
    /*
     * `AND`, not a spread.
     *
     * Spreading `scopeWhere`'s result and then adding a key is how the `feed`
     * scope silently lost its subscription filter once already: the spread was
     * overwritten by the next line. `AND` composes two independent conditions
     * and cannot drop either.
     *
     * The unread condition is applied whatever the scope's own `unreadOnly`
     * says, because the header reads "N unread" beside a toggle that switches
     * the LIST between unread and all — the number must not move when the list
     * does.
     */
    where: {
      AND: [
        scopeWhere(unreadScope(scope), feedIds, user.id),
        { userArticles: { none: { userId: user.id, readAt: { not: null } } } },
      ],
    },
  });
}

/** The same scope, narrowed to its unread rows so the count is comparable. */
function unreadScope(scope: Scope): Scope {
  switch (scope.kind) {
    case "feed":
    case "folder":
      return { ...scope, unreadOnly: true };
    default:
      // `all`, `unread` and `saved` all reduce to "everything subscribed" —
      // the unread filter above is what makes the count unread.
      return { kind: "unread" };
  }
}

/** One article, or null — null when it does not exist OR is not subscribed. */
export async function getArticle(viewer: Viewer, id: number): Promise<Article | null> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  /*
   * Authorized on ARRIVALS, exactly as `scopeWhere` is.
   *
   * These two must agree or the reader gets a list row that opens to nothing.
   * They disagreed: the lists moved to `article_feeds` and this kept matching
   * the OWNING feed, so an article carried by a feed the reader follows but
   * owned by one they do not appeared in the list and returned null when
   * clicked.
   */
  const row = await prisma.article.findFirst({
    where: {
      id: BigInt(id),
      arrivals: { some: { feed: { subscriptions: { some: { userId: user.id } } } } },
    },
    include: {
      userArticles: { where: { userId: user.id } },
      arrivals: { orderBy: [{ firstSeenAt: "asc" }, { feedId: "asc" }] },
    },
  });
  // `include` brings every scalar column, so `extracted_html` and
  // `extract_final_url` arrive without being named — which is why this read
  // uses `include` rather than a `select` it would have to remember to widen.

  // `withBody`, and ONLY here: this is the one read whose result reaches the
  // reading pane. The list reads above deliberately leave it `""`.
  return row === null
    ? null
    : toArticle(row, row.userArticles[0] ?? null, row.arrivals, { withBody: true });
}

/** One feed's `fetch_log` tail. `[]` for a feed this reader does not follow. */
export async function getFeedHealth(viewer: Viewer, feedId: number): Promise<FetchLogEntry[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  const rows = await prisma.fetchLog.findMany({
    where: {
      feedId: BigInt(feedId),
      feed: { subscriptions: { some: { userId: user.id } } },
    },
    orderBy: { at: "desc" },
    take: 20,
  });

  return rows.map(toFetchLogEntry);
}
