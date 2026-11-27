import { signImageUrl } from "@/lib/extract/image-proxy";
import { sanitizeHtml } from "@/lib/extract/sanitize";
import { articles, feeds, folders, subscriptions, ticks } from "@/lib/fixtures";
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
 * Does this feed DELIVER this article?
 *
 * Not `a.feedId === feedId`. Rung 2 is global (§6.1), so one story carried by
 * two feeds is ONE article and `feedId` names only the feed that got there
 * first — every other feed carrying it is recorded in `arrivals`
 * (`article_feeds` in the database).
 *
 * Every scope and every count goes through here, because the database
 * implementation matches on arrivals and the seam test's whole premise is that
 * the UI cannot tell the two apart (Appendix C). Answering this question two
 * ways is how the parity test started failing: the sidebar's badge said 9 from
 * fixtures and 12 from Postgres for the same feed.
 */
function delivers(article: Article, feedId: number): boolean {
  if (article.feedId === feedId) return true;
  // `null` means "not loaded" rather than "none"; the fixtures always have it.
  return article.arrivals?.some((arrival) => arrival.feedId === feedId) ?? false;
}

/** Every feed that delivered this article, owner included. */
function deliveredBy(article: Article): number[] {
  return [...new Set([article.feedId, ...(article.arrivals ?? []).map((a) => a.feedId)])];
}

/**
 * The sidebar: folders, feeds, and a DERIVED unread count.
 *
 * The count is `count(*) WHERE read_at IS NULL` in phase 2 and a filter here —
 * never a stored column before P2, because a counter that drifts is worse than
 * a 15 ms count and this is the number the product's credibility rests on
 * (§6.2).
 *
 * PER-ARRIVAL, like the database's. A story carried by two subscribed feeds
 * counts in BOTH badges — correctly, since both feeds do carry it — which is
 * exactly why the header's total cannot be their sum. See `countUnread`.
 */
export async function listSubscriptions(viewer: Viewer): Promise<SubscriptionWithUnread[]> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);

  return subscriptions
    .filter((s) => s.userId === user.id)
    .map((s) => {
      const feed = feeds.find((f) => f.id === s.feedId);
      if (!feed) throw new Error(`Fixture is inconsistent: no feed ${s.feedId}`);
      const unread = articles.filter((a) => a.readAt === null && delivers(a, s.feedId)).length;
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
  /*
   * Reachable through ANY subscribed feed, not just the owning one.
   *
   * `subscribed.has(article.feedId)` hid an article a reader's own feed
   * carries because another feed owned the row — dedup reading as an article
   * going missing, which is the cost Appendix G question 2 warns about.
   */
  if (!deliveredBy(article).some((id) => subscribed.has(id))) return false;
  switch (scope.kind) {
    case "unread":
      return article.readAt === null;
    case "all":
      return true;
    case "saved":
      return article.savedAt !== null;
    case "feed":
      if (!delivers(article, scope.feedId)) return false;
      return scope.unreadOnly ? article.readAt === null : true;
    case "folder": {
      // Filed by THIS reader. Without the userId another reader's filing of a
      // shared feed would widen this reader's folder — the shared-row mistake
      // the data model exists to prevent.
      const inFolder = subscriptions
        .filter((s) => s.userId === userId && s.folderId === scope.folderId)
        .map((s) => s.feedId);
      if (!inFolder.some((id) => delivers(article, id))) return false;
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

/**
 * DISTINCT unread articles in a scope.
 *
 * A service call rather than a sum over the sidebar's per-feed badges, and the
 * difference is not cosmetic. Rung 2 is global (§6.1), so one story carried by
 * two subscribed feeds is ONE article with TWO arrivals: each feed's badge
 * counts it, correctly, and adding those badges up counts it twice. The header
 * then says "2 unread" over a list holding one row, which is the unread count
 * lying — the one number §6.1 says the product's credibility rests on.
 *
 * The fixtures have no syndicated article yet, so here this equals the sum.
 * It is still asked the same way, because the seam test's premise is that the
 * UI cannot tell the implementations apart (Appendix C).
 */
export async function countUnread(viewer: Viewer, scope: Scope): Promise<number> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const subscribed = subscribedFeedIds(user.id);

  // Always the UNREAD count, whatever the scope's own `unreadOnly` says: the
  // header reads "N unread" beside a toggle that switches the LIST between
  // unread and all, and that number must not move when the list does.
  return articles.filter(
    (a) => a.readAt === null && inScope(a, unreadScope(scope), subscribed, user.id),
  ).length;
}

/** The same scope, narrowed to its unread rows so the count is comparable. */
function unreadScope(scope: Scope): Scope {
  switch (scope.kind) {
    case "feed":
    case "folder":
      return { ...scope, unreadOnly: true };
    default:
      // `all`, `unread` and `saved` all reduce to "everything subscribed",
      // because the `readAt === null` filter above is what makes it unread.
      return { kind: "unread" };
  }
}

/** One article, or null. Null when it does not exist *or* is not subscribed. */
export async function getArticle(viewer: Viewer, id: number): Promise<Article | null> {
  assertCan(viewer, "read");
  const user = requireUser(viewer);
  const subscribed = subscribedFeedIds(user.id);

  const article = articles.find((a) => a.id === id);
  // Reachable through any subscribed feed, matching `inScope` — the two must
  // agree or a listed row opens to nothing.
  if (!article || !deliveredBy(article).some((feedId) => subscribed.has(feedId))) return null;

  /*
   * SANITISED HERE TOO, so the invariant holds on BOTH paths.
   *
   * `Article.body` reaches `dangerouslySetInnerHTML`, and the rule behind that
   * is "nothing but sanitised HTML is ever in this field". The database path
   * cleans `content_html` in `db/map.ts`; this path returned the fixture
   * verbatim — safe today only because the corpus happens to contain no `a` or
   * `img`, which is a property of the data rather than of the code.
   *
   * It is not a trust question. The fixtures are ours, and the sanitiser does
   * more than remove attacks: it makes URLs absolute and adds `rel="noopener
   * noreferrer"` to outbound links. Skipping it meant fixture mode would render
   * a relative href against Cadence's own host, and an unhardened one, the
   * moment anybody added a link to the corpus — a divergence between the two
   * implementations that Appendix C's parity rule exists to prevent and that no
   * current test would catch.
   *
   * `corpus-round-trip.test.ts` asserts this is a no-op on today's corpus, so
   * it costs one DOM parse per article open and buys the invariant.
   */
  return {
    ...article,
    body: sanitizeHtml(article.body, { baseUrl: article.url, rewriteImage: signImageUrl }),
  };
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
export async function listTicks(viewer: Viewer): Promise<Tick[]> {
  assertCan(viewer, "read");
  requireUser(viewer);
  return [...ticks];
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
