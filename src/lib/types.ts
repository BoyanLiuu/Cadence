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

/** A block of article body. Narrow on purpose: feed HTML is sanitised into this. */
export type BodyBlock = { p: string } | { h: string } | { li: string[] };

/** One span of a revision redline (§6.2). */
export type RevisionSpan = string | { del: string } | { ins: string };

/**
 * Every address one article arrived under. `article_urls` is one-to-many on
 * purpose: when a URL changes the old hash stays mapped, so a feed still
 * carrying it resolves to the existing row (§6.1).
 */
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
  body: BodyBlock[];
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
  lastPost: string;
  intervalS: number;
  preview: { title: string; at: string }[];
};

export type DiscoveryResult =
  | { kind: "found"; candidates: Candidate[] }
  | { kind: "none"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "following"; feedId: number };

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
 * What a viewer may do. The denial table is empty through phase 1: there is one
 * fixture reader and nothing to deny them. M11 fills it in, against rules
 * written here rather than invented then.
 */
export type Capability =
  | "read"
  | "subscribe"
  | "unsubscribe"
  | "set-read-state"
  | "save"
  | "merge"
  | "extract"
  | "discover";

// ---------------------------------------------------------------- paging

/**
 * Keyset cursor, ordered on `(publishedAt, id)`. Never `OFFSET` — by month
 * three an offset page scan is what makes every query slow (§3).
 */
export type Cursor = { publishedAt: string; id: number };

export type Scope =
  | { kind: "unread" }
  | { kind: "saved" }
  | { kind: "feed"; feedId: number }
  | { kind: "folder"; folderId: number };

export type Page<T> = { items: T[]; next: Cursor | null };

/** §3: 50 per page. */
export const PAGE_SIZE = 50;
