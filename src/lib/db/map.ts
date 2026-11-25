import { sanitizeHtml } from "@/lib/extract/sanitize";
import type { Article, Feed, FetchLogEntry, Folder, Subscription } from "@/lib/types";

/*
 * Database rows to domain types.
 *
 * One file so there is one place the shapes meet, and so a column rename is a
 * compile error here rather than a wrong value three layers up.
 *
 * Two conversions are not cosmetic:
 *
 *  - `BigInt` to `number`. Postgres `bigserial` arrives as a JS BigInt, which
 *    `JSON.stringify` throws on — so an unconverted id reaching a Server
 *    Component's props is a 500 at render time. Ids are safe as numbers until
 *    2^53 rows, which this will not reach.
 *  - `Date` to ISO string. The domain types are strings because they cross the
 *    server/client boundary and because the fixtures were strings — which is
 *    what lets `service-parity` compare the two implementations at all.
 */

/** Postgres bigint to a plain number. */
export const num = (v: bigint | number): number => (typeof v === "bigint" ? Number(v) : v);

/*
 * Timestamps come back as `2026-11-12T09:12:00.000Z` from `toISOString()`, and
 * the fixtures were written as `2026-11-12T09:12:00Z`. Both are valid ISO 8601
 * and both parse to the same instant — but `service-parity.test.ts` compares
 * them as STRINGS, because that is what a component receives and renders.
 *
 * So one canonical form, and it is the one with milliseconds: it is what
 * `Date.prototype.toISOString` produces, so the database path needs no
 * conversion and only the fixtures are normalised to meet it. Normalising the
 * other way would mean stripping precision from real data to match test data.
 */
export const isoRequired = (v: Date): string => v.toISOString();

/** Postgres timestamptz to ISO, preserving null. */
export const iso = (v: Date | null): string | null => (v === null ? null : isoRequired(v));

type FeedRow = {
  id: bigint;
  feedUrl: string;
  siteUrl: string | null;
  title: string;
  format: string;
  status: string;
  fetchIntervalS: number;
  medianPostGapS: number | null;
  declaredTtlS: number | null;
  unchangedPolls: number;
  consecutiveFailures: number;
  nextFetchAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  deadAt: Date | null;
  notFeedAt: Date | null;
  firstFailureAt: Date | null;
  guidUnstable: boolean;
  guidUnstableSince: Date | null;
  cleanPolls: number;
};

/** A feed's today counters, derived from `fetch_log` rather than stored. */
export type TodayCounters = {
  checks: number;
  n304: number;
  failed: number;
  seen: number;
  new: number;
  mergedByGuid: number;
  mergedByUrl: number;
  mergedByContent: number;
  revised: number;
  /** The guid-trust signal; see `FeedToday` for why the collapse rate is not enough. */
  guidAgreed: number;
  guidChurned: number;
};

export const EMPTY_TODAY: TodayCounters = {
  checks: 0,
  n304: 0,
  failed: 0,
  seen: 0,
  new: 0,
  mergedByGuid: 0,
  mergedByUrl: 0,
  mergedByContent: 0,
  revised: 0,
  guidAgreed: 0,
  guidChurned: 0,
};

/**
 * One `fetch_log` row's code, as the domain sees it.
 *
 * The column is a nullable smallint plus an `error_code` string, because a
 * transport failure has no HTTP status — a timeout is not a 0. The domain type
 * unions them, so `304` and `"timeout"` are both first-class.
 */
function codeOf(statusCode: number | null, errorCode: string | null): FetchLogEntry["code"] {
  if (statusCode !== null) return statusCode;
  if (errorCode === "timeout" || errorCode === "html" || errorCode === "parse") return errorCode;
  // An unrecognised error code is reported as a parse failure rather than
  // guessed at: it is the outcome that says "we could not read it".
  return "parse";
}

export function toFeed(row: FeedRow, today: TodayCounters, log: FetchLogEntry[]): Feed {
  return {
    id: num(row.id),
    title: row.title,
    siteUrl: row.siteUrl ?? "",
    feedUrl: row.feedUrl,
    format: row.format as Feed["format"],
    status: row.status as Feed["status"],
    intervalS: row.fetchIntervalS,
    medianGapS: row.medianPostGapS,
    declaredTtlS: row.declaredTtlS,
    unchangedPolls: row.unchangedPolls,
    consecutiveFailures: row.consecutiveFailures,
    nextFetchAt: iso(row.nextFetchAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastError:
      row.lastErrorAt === null
        ? null
        : {
            at: isoRequired(row.lastErrorAt),
            code: codeOf(
              row.lastErrorCode !== null && /^\d+$/.test(row.lastErrorCode)
                ? Number(row.lastErrorCode)
                : null,
              row.lastErrorCode,
            ),
            text: row.lastErrorText ?? "",
          },
    ...(row.deadAt ? { deadAt: isoRequired(row.deadAt) } : {}),
    ...(row.notFeedAt ? { notFeedAt: isoRequired(row.notFeedAt) } : {}),
    ...(row.firstFailureAt ? { firstFailureAt: isoRequired(row.firstFailureAt) } : {}),
    guidUnstable: row.guidUnstable,
    ...(row.guidUnstableSince ? { guidUnstableSince: isoRequired(row.guidUnstableSince) } : {}),
    // 0 is a real value and null means "has proved itself", so this cannot be
    // collapsed with `||` (§6.1).
    cleanPolls: row.cleanPolls >= 3 ? null : row.cleanPolls,
    today,
    log,
  };
}

export function toFolder(row: {
  id: bigint;
  userId: string;
  name: string;
  position: number;
}): Folder {
  return { id: num(row.id), userId: row.userId, name: row.name, position: row.position };
}

export function toSubscription(row: {
  userId: string;
  feedId: bigint;
  folderId: bigint | null;
  customTitle: string | null;
  fullTextMode: string;
  resurfaceOnRevision: boolean;
  createdAt: Date;
}): Subscription {
  return {
    userId: row.userId,
    feedId: num(row.feedId),
    folderId: row.folderId === null ? null : num(row.folderId),
    customTitle: row.customTitle,
    fullTextMode: row.fullTextMode as Subscription["fullTextMode"],
    resurfaceOnRevision: row.resurfaceOnRevision,
    subscribedAt: isoRequired(row.createdAt),
  };
}

type ArticleRow = {
  id: bigint;
  feedId: bigint;
  title: string;
  author: string | null;
  url: string;
  publishedAt: Date;
  fetchedAt: Date;
  textLen: number | null;
  summaryHtml: string | null;
  contentHtml: string | null;
  extractStatus: string;
  revisedAt: Date | null;
  revisionCount: number;
};

/**
 * One article, with this reader's state joined in.
 *
 * `userState` is nullable because a MISSING `user_articles` row means unread —
 * rows are written lazily, so a reader who has never touched an article has no
 * row for it (§6.2). Defaulting those to `readAt: null` is the whole mechanism.
 */
export function toArticle(
  row: ArticleRow,
  userState: { readAt: Date | null; savedAt: Date | null; wasReadAt: Date | null } | null,
  /**
   * Every feed that delivered this article, from `article_feeds`.
   *
   * Omitted rather than defaulted, because `null` and `[]` mean different
   * things to `alsoInFeedCount`: null is "not loaded", an array is the answer.
   * This was hard-coded `null`, which left Appendix E's "also in 2 feeds" panel — the
   * stated reason `article_feeds` exists — rendering nothing in the database
   * path while working in fixtures. A seam the fixtures pass and Postgres
   * fails is the exact thing Appendix C's parity rule is for.
   */
  arrivals?: { feedId: bigint; url: string | null; firstSeenAt: Date }[],
  /**
   * Whether to sanitise and return the body.
   *
   * OFF BY DEFAULT, because a list page maps fifty rows and no list renders a
   * body — only the reading pane does. Sanitising fifty articles' HTML to
   * throw it away is a DOM parse per row on every page of every scope.
   *
   * It is not an optimisation of the security boundary, which is the thing to
   * be careful about here: an omitted body is `""`, never the raw column. The
   * only way to get markup out of this function is to ask for it, and asking
   * runs it through `sanitizeHtml`.
   */
  options: { withBody?: boolean } = {},
): Article {
  return {
    id: num(row.id),
    feedId: num(row.feedId),
    title: row.title,
    author: row.author ?? "",
    url: row.url,
    publishedAt: isoRequired(row.publishedAt),
    fetchedAt: isoRequired(row.fetchedAt),
    // Stored as a character count; the domain speaks in words, which is what
    // the reading-time estimate needs.
    words: row.textLen === null ? 0 : Math.max(1, Math.round(row.textLen / 6)),
    summary: row.summaryHtml ?? "",
    /*
     * SANITISED HERE, at the data boundary, and this is the only place the
     * column is read.
     *
     * `content_html` is third-party markup — it arrived over the network from a
     * publisher — so it is cleaned before it can reach a component, and the
     * client therefore never holds markup it has to remember to clean. §6.5
     * frames sanitisation as extraction's problem because that is where it was
     * noticed; the feed path has had the same exposure since M2 and simply
     * never rendered it. This used to be `[{ p: row.contentHtml }]`, one
     * paragraph holding the whole document, which React escaped — so every
     * article showed its own markup as visible text.
     *
     * Resolved against the ARTICLE's own address, which is where its relative
     * links and images are relative to.
     */
    body:
      options.withBody === true && row.contentHtml
        ? sanitizeHtml(row.contentHtml, { baseUrl: row.url })
        : "",
    extractStatus: row.extractStatus as Article["extractStatus"],
    revisedAt: iso(row.revisedAt),
    revisionCount: row.revisionCount,
    revision: null,
    /*
     * `how` is derived, not stored: the EARLIEST arrival is the one
     * `articles.feed_id` names and the one the row's metadata came from, so it
     * is "first"; every later one resolved at a rung, which for a cross-feed
     * collapse is always rung 2 (rungs 1 and 3 are scoped to the feed).
     */
    arrivals:
      arrivals === undefined
        ? null
        : arrivals.map((a, i) => ({
            feedId: num(a.feedId),
            // Null only for an arrival written before the column existed, or
            // an item a feed published with no link at all (§6.3). The
            // article's own address is the closest true answer for both.
            url: a.url ?? row.url,
            at: isoRequired(a.firstSeenAt),
            how: i === 0 ? ("first" as const) : ("url" as const),
          })),
    readAt: iso(userState?.readAt ?? null),
    savedAt: iso(userState?.savedAt ?? null),
    ...(userState?.wasReadAt ? { wasReadAt: isoRequired(userState.wasReadAt) } : {}),
  };
}

export function toFetchLogEntry(row: {
  at: Date;
  statusCode: number | null;
  errorCode: string | null;
  durationMs: number;
  itemsSeen: number;
  itemsNew: number;
  mergedByGuid: number;
  mergedByUrl: number;
  mergedByContent: number;
  revised: number;
  note: string | null;
}): FetchLogEntry {
  return {
    at: isoRequired(row.at),
    code: codeOf(row.statusCode, row.errorCode),
    ms: row.durationMs,
    itemsSeen: row.itemsSeen,
    itemsNew: row.itemsNew,
    mergedByGuid: row.mergedByGuid,
    mergedByUrl: row.mergedByUrl,
    mergedByContent: row.mergedByContent,
    revised: row.revised,
    ...(row.note ? { note: row.note } : {}),
  };
}
