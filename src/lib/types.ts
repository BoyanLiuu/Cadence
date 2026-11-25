/*
 * The vocabulary of the whole app.
 *
 * Names follow ARCHITECTURE Appendix D, camel-cased. Where the prototype's
 * sample data used a shorter name (`extract` for `extract_status`), the
 * architecture's name wins — the fixtures are what gets renamed, not the
 * schema, because phase 2 writes the schema and must not have to translate.
 */

// ---------------------------------------------------------------- feeds

/** Appendix D: `feeds.format`. Decided by the root element, never by Content-Type (§6.3). */
export type FeedFormat = "rss2" | "rss1" | "atom" | "json" | "unknown";

/**
 * What `sniff` concluded a body is, from its bytes.
 *
 * Wider than `FeedFormat` by one value: `not_a_feed` means "this is a web
 * page", which carries its own copy and its own terminal feed state (§6.3).
 */
export type Dialect = FeedFormat | "not_a_feed";

/**
 * Appendix D: `feeds.status`.
 *
 * `not_a_feed` is a terminal, *reported* state rather than an error — a 200 with
 * an HTML body is the most common user-visible failure and it must not be a 500
 * (§6.3).
 */
export type FeedStatus = "active" | "backoff" | "dead" | "not_a_feed";

/** Per-subscription full-text policy. `always` takes on crawler obligations (§6.5). */
export type FullTextMode = "off" | "on_demand" | "always";

/** Which rung of the ladder decided an item's identity (§6.1). */
export type MergeRung = "guid" | "url" | "content";

export type FeedError = {
  at: string;
  /** An HTTP status, or a transport outcome a status code cannot express. */
  code: number | "timeout" | "html" | "parse";
  text: string;
};

/** One poll attempt. The only evidence that dedup works (§6.2, Appendix D). */
export type FetchLogEntry = {
  at: string;
  code: number | "timeout" | "html" | "parse";
  ms: number;
  itemsSeen: number;
  itemsNew: number;
  /** Collapses by rung, split so the health screen can show which rung worked. */
  mergedByGuid: number;
  mergedByUrl: number;
  mergedByContent: number;
  revised: number;
  note?: string;
};

/** Today's counters, derived from `fetch_log` since 00:00 UTC. */
export type FeedToday = {
  checks: number;
  n304: number;
  failed: number;
  seen: number;
  new: number;
  mergedByGuid: number;
  mergedByUrl: number;
  mergedByContent: number;
  revised: number;
  /*
   * The guid-trust signal, which the collapse rate CANNOT express.
   *
   * "92 % collapsed by address" has two completely different causes and the
   * reader needs to tell them apart:
   *
   *   the feed is new      rung 1 is not routing yet, so everything legitimately
   *                        matches at rung 2. The publisher is faultless.
   *   the ids churn        the publisher regenerates its guids on every build,
   *                        and rung 1 would insert a duplicate for every item
   *                        if it were trusted.
   *
   * Through `mergedByUrl` alone those are identical. These two say which, and
   * they are the numbers Appendix E's "verify rather than trust" rests on for
   * this column.
   */
  guidAgreed: number;
  guidChurned: number;
};

export type Feed = {
  id: number;
  title: string;
  siteUrl: string;
  feedUrl: string;
  format: FeedFormat;
  status: FeedStatus;
  intervalS: number;
  medianGapS: number | null;
  /** `<ttl>` is a FLOOR, never a ceiling (§6.4). */
  declaredTtlS: number | null;
  unchangedPolls: number;
  consecutiveFailures: number;
  nextFetchAt: string | null;
  lastSuccessAt: string | null;
  lastError: FeedError | null;
  deadAt?: string;
  notFeedAt?: string;
  firstFailureAt?: string;
  /** Failures folded out of a dead feed's visible log. */
  olderFailures?: number;
  /**
   * A learned quirk, not configuration. Once set, rung 1 is skipped for this
   * feed forever (§6.1).
   */
  guidUnstable: boolean;
  guidUnstableSince?: string;
  /** `null` once the feed has proved itself; 0–2 means rung 2 runs as a pre-check (§6.1). */
  cleanPolls: number | null;
  today: FeedToday;
  /** Newest first. */
  log: FetchLogEntry[];
};

/**
 * Appendix D: `folders id, user_id FK, name, position`.
 *
 * A folder is per-user, like a subscription and unlike a feed. `userId` is on
 * the row rather than implied by the query, so a read that forgets to scope is
 * a type the service layer can still catch.
 */
export type Folder = { id: number; userId: string; name: string; position: number };

/**
 * One reader following one feed. Primary key `(userId, feedId)` — the key that
 * makes a feed shared and a following private.
 */
export type Subscription = {
  userId: string;
  feedId: number;
  folderId: number | null;
  customTitle: string | null;
  fullTextMode: FullTextMode;
  resurfaceOnRevision: boolean;
  subscribedAt: string;
};

/** What the sidebar renders: the subscription, its feed, and a *derived* count. */
export type SubscriptionWithUnread = Subscription & {
  feed: Feed;
  /** `count(*) WHERE read_at IS NULL`. Never a stored column before P2 (§6.2). */
  unread: number;
};

// ---------------------------------------------------------------- articles

/** Appendix D: `articles.extract_status` (§6.5). */
export type ExtractStatus = "none" | "ok" | "thin" | "blocked" | "failed";

/** One span of a revision redline (§6.2). */
export type RevisionSpan = string | { del: string } | { ins: string };

/**
 * Every address one article arrived under. `article_urls` is one-to-many on
 * purpose: when a URL changes the old hash stays mapped, so a feed still
 * carrying it resolves to the existing row (§6.1).
 */
/** How many OTHER feeds an article arrived through, excluding its own. */
export function otherFeedCount(article: {
  feedId: number;
  arrivals: { feedId: number }[] | null;
}): number {
  if (!article.arrivals) return 0;
  // Distinct feeds, not arrivals. Two arrivals can share a feed — a feed that
  // republished an article at a new address — and "Also in 2 feeds" when it is
  // one feed twice is the kind of wrong count this product cannot afford.
  const others = new Set(article.arrivals.map((a) => a.feedId));
  others.delete(article.feedId);
  return others.size;
}

export type Arrival = {
  feedId: number;
  url: string;
  at: string;
  how: "first" | "url";
};

/**
 * One real-world article, owned by a feed and shared by every subscriber.
 *
 * It has **no owner and no read state** — those live in `user_articles`, which
 * is what makes one fetch serve ten readers. `readAt` and `savedAt` below are
 * the *viewer's* state joined in by the service layer, not columns on the row.
 */
export type Article = {
  id: number;
  feedId: number;
  title: string;
  author: string;
  url: string;
  publishedAt: string;
  fetchedAt: string;
  words: number;
  summary: string;
  /**
   * The article body as SANITISED HTML (§6.5), or `""` when there is none.
   *
   * Was `BodyBlock[]` — `{p} | {h} | {li[]}` — which could not carry `img`,
   * `a`, `blockquote`, `pre`, `table` or `em`, all of which §6.5's allowlist
   * permits and real articles use. A tree narrow enough to be obviously safe
   * cannot carry an article, so the safety boundary is the sanitiser rather
   * than the shape. NOTHING may put unsanitised markup here.
   */
  body: string;
  extractStatus: ExtractStatus;
  /** Set when a rung matched and the body had changed. Does NOT clear `readAt` (§6.2). */
  revisedAt: string | null;
  revisionCount: number;
  revision: RevisionSpan[] | null;
  arrivals: Arrival[] | null;

  // -- the viewer's state, from `user_articles`. A missing row means unread.
  readAt: string | null;
  savedAt: string | null;
  /** Only where a feed opts into resurfacing; shows what the read state had been. */
  wasReadAt?: string;
};

// ---------------------------------------------------------------- ingest

/**
 * The one shape every format normalises to (§6.3). `parse.ts` is the only
 * format-aware module, which is why swapping the parser is a one-file change.
 *
 * Declared here in M1 and produced in M2. Nothing in phase 1 builds one.
 */
export type RawItem = {
  guid: string | null;
  url: string | null;
  title: string | null;
  author: string | null;
  /** Prefers `published` over `updated`, so an edit does not jump to the top (§6.3). */
  publishedAt: string | null;
  /** Prefers `content:encoded` over `description`, so a teaser does not win (§6.3). */
  contentHtml: string | null;
  summaryHtml: string | null;
  /**
   * This item's own `xml:base`, when it declares one.
   *
   * `xml:base` is legal on any element and it NESTS, so an entry can narrow
   * the feed's base. Carried per item rather than per feed because getting it
   * wrong does not merely break a link: a wrong URL is a wrong `url_hash`,
   * which is rung 2's dedupe key, so the same article arriving through two
   * feeds would fail to collapse and a duplicate would reach the reader.
   *
   * Usually null. Often relative, so it resolves against the feed's base
   * before the item's URL resolves against it (§6.3's chain, nested).
   */
  xmlBase: string | null;
};

/** One `POST /api/cron/poll` run, grouped from `fetch_log` (§6.4). */
export type Tick = {
  at: string;
  ms: number;
  work: { feedId: number; code: FetchLogEntry["code"]; note?: string }[];
};

// ---------------------------------------------------------------- discovery

/** A validated candidate. The discoverer fetches every one before offering it (§6.3). */
export type Candidate = {
  title: string;
  feedUrl: string;
  format: FeedFormat;
  items: number;
  /** ISO 8601, or `""` for a feed whose items carry no date at all. */
  lastPost: string;
  intervalS: number;
  preview: { title: string; at: string }[];
  /**
   * Set when this reader already follows this feed.
   *
   * PER CANDIDATE, because "already followed" is the only part of a discovery
   * that depends on who is asking, and a page can advertise several feeds of
   * which one is followed. The whole-result `following` kind below stays for
   * the case it describes — every candidate already followed, which is what
   * pasting a single feed address produces — and this marks the others without
   * hiding them.
   */
  following?: boolean;
};

/**
 * What a discovery attempt concluded.
 *
 * FOUR distinct failures, not one. M5's test requirement is that each renders
 * its own designed message, because a reader who pasted a site with no feed, a
 * site that timed out, a feed they already follow and a typo need four
 * different next actions — and "something went wrong" serves none of them.
 */
export type DiscoveryResult =
  | { kind: "found"; candidates: Candidate[] }
  | { kind: "none"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "following"; feedId: number }
  /** Not an address at all. Caught before any lookup. */
  | { kind: "invalid"; reason: string };

/** The result of one on-open extraction (§6.5). */
export type Extraction = {
  articleId: number;
  status: ExtractStatus;
  contentHtml: string | null;
  finalUrl: string | null;
};

// ---------------------------------------------------------------- the viewer

export type User = {
  /** The Clerk user id. There is no second identifier (Appendix B). */
  id: string;
  email: string;
  name: string;
  initials: string;
  tz: string;
  aiEnabled: boolean;
};

/**
 * Who is acting. Resolved from the session once per request and passed down —
 * never taken from a request argument (§3).
 */
export type Viewer = { kind: "anon" } | { kind: "user"; user: User };

/**
 * What a viewer may do.
 *
 * AN ARRAY, with the type derived from it, so there is something to ENUMERATE
 * at runtime. As a bare union this was a type and nothing else, and
 * `assertCan`'s denial test could only name capabilities by hand — it checked
 * two of the eight. A ninth added to the union would have been denied to nobody
 * and tested by nothing, which is the one failure this table cannot afford.
 *
 * `satisfies` keeps the array and the type in step in the only direction that
 * can drift: adding to the array widens the type, and the suite that iterates
 * it then covers the new entry automatically.
 */
export const CAPABILITIES = [
  "read",
  "subscribe",
  "unsubscribe",
  "set-read-state",
  "save",
  "extract",
  "discover",
] as const satisfies readonly string[];

export type Capability = (typeof CAPABILITIES)[number];

// ---------------------------------------------------------------- paging

/**
 * Keyset cursor, ordered on `(publishedAt, id)`. Never `OFFSET` — by month
 * three an offset page scan is what makes every query slow (§3).
 */
export type Cursor = { publishedAt: string; id: number };

/**
 * Which articles a list is drawn from.
 *
 * `unread` and `all` are the two halves of the reader's Unread/All toggle over
 * every subscribed feed; `feed` and `folder` narrow it and carry their own
 * copy of the toggle, because the toggle is per-view in the prototype.
 */
export type Scope =
  | { kind: "unread" }
  | { kind: "all" }
  | { kind: "saved" }
  | { kind: "feed"; feedId: number; unreadOnly?: boolean }
  | { kind: "folder"; folderId: number; unreadOnly?: boolean };

/**
 * Filters applied WITHIN a scope.
 *
 * Separate from `Scope` because they compose with every scope rather than
 * replacing one, and because the keyset cursor is only valid for a fixed
 * filter — changing the search term starts a new first page, it does not
 * continue the old one.
 */
export type ListFilter = {
  /** Case-insensitive substring of the title. The reader's "Search titles". */
  query?: string;
};

export type Page<T> = { items: T[]; next: Cursor | null };

/** §3: 50 per page. */
export const PAGE_SIZE = 50;
