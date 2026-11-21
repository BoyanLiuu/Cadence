import { prisma } from "@/lib/db/client";
import {
  EMPTY_TODAY,
  toArticle,
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
    },
  });

  // A 304 is a SUCCESS, not an absence of one (§6.4), so it is counted
  // separately rather than inferred from "no items".
  const notModified = await prisma.fetchLog.groupBy({
    by: ["feedId"],
    where: { feedId: { in: feedIds }, at: { gte: startOfUtcDay() }, statusCode: 304 },
    _count: { _all: true },
  });
  const failed = await prisma.fetchLog.groupBy({
    by: ["feedId"],
    where: { feedId: { in: feedIds }, at: { gte: startOfUtcDay() }, errorCode: { not: null } },
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
  const today = await todayByFeed(feedIds);

  const [totals, read] = await Promise.all([
    prisma.article.groupBy({
      by: ["feedId"],
      where: { feedId: { in: feedIds } },
      _count: { _all: true },
    }),
    prisma.userArticle.groupBy({
      by: ["articleId"],
      where: { userId: user.id, readAt: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Which of this reader's read articles belong to which feed. One extra query
  // rather than a correlated subquery per feed.
  const readIds = read.map((r) => r.articleId);
  const readByFeed = new Map<string, number>();
  if (readIds.length > 0) {
    const rows = await prisma.article.groupBy({
      by: ["feedId"],
      where: { id: { in: readIds } },
      _count: { _all: true },
    });
    for (const r of rows) readByFeed.set(String(r.feedId), r._count._all);
  }
  const totalByFeed = new Map(totals.map((r) => [String(r.feedId), r._count._all]));

  const { toFeed } = await import("@/lib/db/map");
  return subs.map((s) => {
    const key = String(s.feedId);
    const unread = (totalByFeed.get(key) ?? 0) - (readByFeed.get(key) ?? 0);
    return {
      ...toSubscription(s),
      feed: toFeed(s.feed, today.get(key) ?? EMPTY_TODAY, s.feed.fetchLog.map(toFetchLogEntry)),
      unread: Math.max(0, unread),
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
export async function listTicks(viewer: Viewer): Promise<{ ticks: Tick[]; budgetMs: number }> {
  assertCan(viewer, "read");
  requireUser(viewer);

  // Grouped by the minute they ran in: one tick is one `POST /api/cron/poll`
  // invocation, and it may touch several feeds.
  const rows = await prisma.fetchLog.findMany({
    orderBy: { at: "desc" },
    take: 40,
    select: {
      at: true,
      durationMs: true,
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
      existing.ms = Math.max(existing.ms, row.durationMs);
    } else {
      byMinute.set(minute, { at: row.at.toISOString(), ms: row.durationMs, work: [work] });
    }
  }

  return { ticks: [...byMinute.values()].slice(0, 6), budgetMs: 240_000 };
}

/** The where-clause for a scope, scoped to this reader's subscriptions. */
function scopeWhere(scope: Scope, feedIds: bigint[], userId: string) {
  const base = { feedId: { in: feedIds } };
  const unread = { userArticles: { none: { userId, readAt: { not: null } } } };

  switch (scope.kind) {
    case "unread":
      return { ...base, ...unread };
    case "all":
      return base;
    case "saved":
      return { ...base, userArticles: { some: { userId, savedAt: { not: null } } } };
    case "feed":
      return {
        feedId: BigInt(scope.feedId),
        ...(scope.unreadOnly ? unread : {}),
      };
    case "folder":
      return {
        feed: { subscriptions: { some: { userId, folderId: BigInt(scope.folderId) } } },
        ...base,
        ...(scope.unreadOnly ? unread : {}),
      };
  }
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
    include: { userArticles: { where: { userId: user.id } } },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    // One extra row, to learn whether a further page exists without a second
    // COUNT — and without returning a cursor on a full final page, which costs
    // an empty request and an empty-state flash.
    take: PAGE_SIZE + 1,
  });

  const items = rows.slice(0, PAGE_SIZE).map((r) => toArticle(r, r.userArticles[0] ?? null));
  const last = items.at(-1);
  const next =
    last && rows.length > PAGE_SIZE ? { publishedAt: last.publishedAt, id: last.id } : null;

  return { items, next };
}

/** One article, or null — null when it does not exist OR is not subscribed. */
export async function getArticle(viewer: Viewer, id: number): Promise<Article | null> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  const row = await prisma.article.findFirst({
    where: {
      id: BigInt(id),
      feed: { subscriptions: { some: { userId: user.id } } },
    },
    include: { userArticles: { where: { userId: user.id } } },
  });

  return row === null ? null : toArticle(row, row.userArticles[0] ?? null);
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
