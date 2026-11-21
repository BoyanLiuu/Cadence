import { articles, BUDGET_MS, feeds, folders, subscriptions, ticks } from "@/lib/fixtures";
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
 * The data access boundary (ARCHITECTURE Appendix C) — FIXTURE implementation.
 *
 * Kept, not deleted, and not legacy. Appendix C rule 5: the fixture corpus is
 * the test corpus. The phase-2 check is the SEAM TEST — swap the service
 * implementation back to fixtures and the UI must be identical — which is only
 * possible while both implementations exist and answer the same questions.
 *
 * `article-service.ts` chooses between this and `article-service.db.ts`.
 *
 * Every signature here is written once, in M1, and does not change when M6–M9
 * replace the body with Postgres. Three properties make that true, and all
 * three are load-bearing rather than stylistic:
 *
 *  1. Every function is `async`, even while it reads an in-memory array, so no
 *     call site changes shape when a real query arrives.
 *  2. The viewer is the FIRST argument of every function, so scoping is written
 *     into the contract instead of being remembered later.
 *  3. Reads go through `assertCan` too, not just writes — §2 is explicit that
 *     there is no public reading surface.
 *
 * The phase-2 check is the seam test: swap this implementation back to fixtures
 * and the UI must be byte-identical (`service-parity.spec.ts`, M6).
 */

/** This reader's subscribed feed ids. Every read is filtered through it. */
function subscribedFeedIds(userId: string): Set<number> {
  return new Set(subscriptions.filter((s) => s.userId === userId).map((s) => s.feedId));
}

/**
 * The sidebar: folders, feeds, and a DERIVED unread count.
 *
 * The count is `count(*) WHERE read_at IS NULL` in phase 2 and a filter here —
 * never a stored column before P2, because a counter that drifts is worse than
 * a 15 ms count and this is the number the product's credibility rests on
 * (§6.2).
 */
export async function listSubscriptions(viewer: Viewer): Promise<SubscriptionWithUnread[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  return subscriptions
    .filter((s) => s.userId === user.id)
    .map((s) => {
      const feed = feeds.find((f) => f.id === s.feedId);
      if (!feed) throw new Error(`Fixture is inconsistent: no feed ${s.feedId}`);
      const unread = articles.filter((a) => a.feedId === s.feedId && a.readAt === null).length;
      return { ...s, feed, unread };
    });
}

/**
 * The folder tree. Flat in the MVP; nesting is not a requirement (Appendix A).
 *
 * Scoped by `userId` even though the fixture has one reader, because a filter
 * that is correct only while there is one row is a bug waiting for the second.
 */
export async function listFolders(viewer: Viewer): Promise<Folder[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  return folders.filter((f) => f.userId === user.id).sort((a, b) => a.position - b.position);
}

function inScope(article: Article, scope: Scope, subscribed: Set<number>, userId: string): boolean {
  if (!subscribed.has(article.feedId)) return false;
  switch (scope.kind) {
    case "unread":
      return article.readAt === null;
    case "all":
      return true;
    case "saved":
      return article.savedAt !== null;
    case "feed":
      if (article.feedId !== scope.feedId) return false;
      return scope.unreadOnly ? article.readAt === null : true;
    case "folder": {
      // Filed by THIS reader. Without the userId another reader's filing of a
      // shared feed would widen this reader's folder — the shared-row mistake
      // the data model exists to prevent.
      const inFolder = subscriptions
        .filter((s) => s.userId === userId && s.folderId === scope.folderId)
        .map((s) => s.feedId);
      if (!inFolder.includes(article.feedId)) return false;
      return scope.unreadOnly ? article.readAt === null : true;
    }
  }
}

/**
 * Title search, applied within a scope.
 *
 * Matched on the title only, which is what the prototype's control says it
 * does — "Search titles". Full-text search over bodies is P2 and wants the
 * `pg_trgm` index, so promising it here with a substring match would be a
 * worse answer than not offering it.
 */
function matchesFilter(article: Article, filter: ListFilter | undefined): boolean {
  const query = filter?.query?.trim().toLowerCase();
  if (!query) return true;
  return article.title.toLowerCase().includes(query);
}

/**
 * One page of articles, newest first, ordered on `(publishedAt, id)`.
 *
 * Keyset, never `OFFSET` (§3). The cursor is the last row of the previous page
 * rather than a row count, so inserting an article mid-read cannot duplicate or
 * skip a row — which an offset would, and which reads to a user as the list
 * losing something.
 */
export async function listArticles(
  viewer: Viewer,
  scope: Scope,
  cursor?: Cursor,
  filter?: ListFilter,
): Promise<Page<Article>> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const subscribed = subscribedFeedIds(user.id);

  const all = articles.filter(
    (a) => inScope(a, scope, subscribed, user.id) && matchesFilter(a, filter),
  );

  const after = cursor
    ? all.filter(
        (a) =>
          a.publishedAt < cursor.publishedAt ||
          (a.publishedAt === cursor.publishedAt && a.id < cursor.id),
      )
    : all;

  const items = after.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  // A next cursor only when a further row actually exists. Returning one on a
  // full final page costs an empty request and an empty-state flash.
  const next =
    last && after.length > items.length ? { publishedAt: last.publishedAt, id: last.id } : null;

  return { items, next };
}

/** One article, or null. Null when it does not exist *or* is not subscribed. */
export async function getArticle(viewer: Viewer, id: number): Promise<Article | null> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const subscribed = subscribedFeedIds(user.id);

  const article = articles.find((a) => a.id === id);
  if (!article || !subscribed.has(article.feedId)) return null;
  return article;
}

/**
 * The recent ticks, and the per-invocation budget they are measured against.
 *
 * Behind the service boundary like every other read, rather than imported from
 * `lib/fixtures` by the page. The health page was the first route to reach past
 * Appendix C and read fixture data directly — which is the seam
 * `service-contract.test.ts` exists to hold, and which M10 has to replace with
 * a `fetch_log` query. A page that imports fixtures cannot be swapped.
 */
export async function listTicks(viewer: Viewer): Promise<{ ticks: Tick[]; budgetMs: number }> {
  assertCan(viewer, "read");
  requireUser(viewer);
  return { ticks: [...ticks], budgetMs: BUDGET_MS };
}

/**
 * One feed's `fetch_log` tail — the health screen's only input.
 *
 * Returns `[]` for a feed this reader does not follow rather than throwing, so
 * a stale link renders an empty state instead of a 500.
 */
export async function getFeedHealth(viewer: Viewer, feedId: number): Promise<FetchLogEntry[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  if (!subscribedFeedIds(user.id).has(feedId)) return [];
  return [...(feeds.find((f) => f.id === feedId)?.log ?? [])];
}
