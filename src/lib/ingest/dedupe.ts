import {
  findByContentHash,
  findByGuidHash,
  findByUrlHash,
  findManyByContentHash,
  findManyByGuidHash,
  findManyByUrlHash,
  isGuidCollision,
  isUrlCollision,
  mergeInto,
  upsertByGuid,
  upsertByUrl,
  type ArticleWrite,
  type UrlMatch,
} from "@/lib/db/queries";
import type { MergeRung, RawItem } from "@/lib/types";

import { recordArrival, recordUrl } from "./article-urls";
import { canonicalUrl, NORM_VERSION } from "./canonical-url";
import { contentHash } from "./content-hash";

/*
 * THE LADDER. ARCHITECTURE §6.1 is the specification and this is the file it
 * describes.
 *
 * The invariant: ONE REAL-WORLD ARTICLE MAPS TO EXACTLY ONE ROW, FOREVER.
 * Everything downstream depends on it — an unread count is
 * `count(*) WHERE read_at IS NULL`, so an ingester that can produce a second
 * row for an article already read makes the count lie, and a reader that lies
 * about unread counts is dead. Readers do not leave over missing features.
 * They leave when it says 14 unread and there is nothing new.
 *
 * Identity is not a field — no field survives contact with real publishers.
 * It is a resolution PROCEDURE, run per item at write time, first match wins:
 *
 *   rung 1 · (feed_id, guid_hash)   the publisher's own claim.
 *                                   SKIPPED when feeds.guid_unstable is set
 *   rung 2 · url_hash  (GLOBAL)     canonicalised URL, across all feeds.
 *                                   collapses syndication AND guid churn
 *   rung 3 · content_hash           sha256(normTitle + first 500 chars)
 *   otherwise                       genuinely new -> INSERT
 *
 * Rungs 1 and 2 are arbitrated by UNIQUE CONSTRAINTS, not by a prior SELECT:
 * check-then-insert is a race and two overlapping ticks are normal. The code
 * attempts a write and reads the answer out of what the database did.
 */

/** Per-poll counters. These become one `fetch_log` row (§6.2). */
export type LadderCounters = {
  itemsSeen: number;
  itemsNew: number;
  mergedByGuid: number;
  mergedByUrl: number;
  mergedByContent: number;
  revised: number;
  /** Items with no guid, no url and no title. Dropped, never synthesised (§6.3). */
  droppedNoIdentity: number;
  /**
   * New articles the per-poll cap refused (N7).
   *
   * Counted separately from `itemsNew` so the health screen can say HOW MANY
   * were refused. "The cap was hit" alone does not distinguish a feed that
   * overshot by one from a CMS that republished four thousand articles, and
   * those want different responses from the operator.
   */
  itemsCapped: number;
  /** True when the per-poll insert cap refused at least one insert (N7). */
  capHit: boolean;

  /*
   * THE GUID-TRUST SIGNAL, and the only measure that can bootstrap.
   *
   * §6.1's detector is `items_merged_by_url / items_seen > 0.8`, and that is
   * correct for a feed whose guids are already TRUSTED: rung 1 routes, so a
   * churned guid shows up as a rung-2 merge. Applied to an UNTRUSTED feed it
   * inverts — rung 1 does not route at all, so every re-polled item merges at
   * rung 2 and the rate is 1.0 for a perfectly well-behaved publisher.
   *
   * Taken literally that permanently demotes every new feed on its first three
   * polls, which is the opposite of "trusted slowly". So trust is earned on
   * whether the publisher's guid AGREED with the row the ladder actually
   * matched — a question that can be asked whether or not rung 1 is routing,
   * because the guid map is loaded either way.
   */
  /** Matched an existing article, and the item's guid pointed at that same row. */
  guidAgreed: number;
  /**
   * Matched an existing article while carrying a guid that pointed elsewhere.
   *
   * "Elsewhere" is nothing at all, or a different row. Either way the publisher
   * changed an identifier it had promised to keep — the static-site generator
   * baking a build timestamp into the guid, which is the case §6.1 calls
   * adversarial.
   */
  guidChurned: number;
};

export function emptyCounters(): LadderCounters {
  return {
    itemsSeen: 0,
    itemsNew: 0,
    mergedByGuid: 0,
    mergedByUrl: 0,
    mergedByContent: 0,
    revised: 0,
    droppedNoIdentity: 0,
    itemsCapped: 0,
    capHit: false,
    guidAgreed: 0,
    guidChurned: 0,
  };
}

/**
 * The per-poll insert cap (N7).
 *
 * One bad CMS deploy can republish an entire archive with fresh guids. Without
 * a cap that floods the unread count with thousands of rows a reader never
 * asked for, and the damage is not undoable — the rows are real and some will
 * have been read. The plan puts this in M7 rather than after the incident.
 */
export const INSERT_CAP_PER_POLL = 500;

/** What the feed's learned state says about trusting its guids (§6.1). */
export type FeedTrust = {
  id: bigint;
  /** Once set, rung 1 is skipped for this feed FOREVER. */
  guidUnstable: boolean;
  /** Under 3 means rung 2 runs as a pre-check before rung 1 can insert. */
  cleanPolls: number;
  guidTrustOverride: "auto" | "guid" | "url";
};

/**
 * Is the row we matched one THIS FEED owns?
 *
 * The guid-trust signal is only meaningful for rows whose identifier this feed
 * supplied, and that is not every row it matches — rung 2 is GLOBAL while the
 * guid map is scoped to `feed_id`. So a feed that overlaps another feed's
 * articles matches them at rung 2, finds nothing in its own guid map, and looks
 * like it churned every identifier it has.
 *
 * That was a real and bad failure, because the overlap is ordinary: a site's
 * main feed plus one of its category feeds, an aggregator, or the syndication
 * rung 2 exists to collapse. Such a feed scored 100% churn on EVERY poll, was
 * flagged `guid_unstable` on its third, and could never recover — `mergeInto`
 * does not write `guid_hash`, so the row keeps the owner's identifier forever.
 * The health screen then told the reader the publisher "changed its ids on
 * every build", which was false.
 *
 * Judged on `articles.feed_id`, the feed that saw the article first, because
 * that is the feed whose guid is stored on the row.
 */
function ownsMatchedRow(
  feedId: bigint,
  resolution: Resolution,
  known: KnownMaps,
  urlHex: string,
): boolean {
  // Rung 1 matched, so the row is in this feed's own guid map by construction.
  if (resolution.rung === "guid") return true;
  // Rung 3 is feed-scoped too: `findManyByContentHash` takes the feed id.
  if (resolution.rung === "content") return true;
  // Rung 2 is the global one. Looked up by THIS ITEM'S address, which is how
  // rung 2 matched in the first place, so it is one map hit rather than a scan
  // of the whole poll per item. A match we cannot find is not judged, which is
  // the conservative direction.
  return known.byUrl.get(urlHex)?.ownerFeedId === feedId;
}

/**
 * Does rung 1 ROUTE for this feed?
 *
 * Skipped when `guid_unstable` is set — a learned quirk, not configuration, and
 * once set it is skipped FOREVER. Also skipped while the feed has fewer than
 * three clean polls: §6.1's "trusted slowly", and the promise the add-feed
 * screen makes to the reader.
 *
 * One function rather than the same expression in two places, because the two
 * copies could drift and the consequence of them disagreeing is duplicates.
 *
 * Note what this does NOT gate: the guid LOOKUP still runs either way, because
 * `guidAgreed`/`guidChurned` are how a feed earns its way out of the untrusted
 * state. Gating the lookup on trust made the signal unobservable on exactly the
 * feeds being judged.
 */
export function trustsGuids(feed: FeedTrust): boolean {
  if (feed.guidTrustOverride === "guid") return true;
  if (feed.guidTrustOverride === "url") return false;
  return !feed.guidUnstable && feed.cleanPolls >= 3;
}

/** One item's resolution. `rung` is null when the article was new. */
export type Resolution = {
  articleId: bigint;
  rung: MergeRung | null;
  revised: boolean;
};

/** A digest as the `Uint8Array<ArrayBuffer>` Prisma's Bytes columns expect. */
const sha = (v: Uint8Array | Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(v);

/**
 * Rung 2's key for an article address, or null for one that cannot be keyed.
 *
 * EXPORTED so there is ONE definition of this composition. It is
 * `canonicalUrl` then `contentHash` then the byte narrowing, and getting any
 * step wrong produces a hash that looks fine and matches nothing — a lookup
 * that silently never hits, which is how a duplicate gets inserted. M13's
 * extraction needs it to append the resolved final URL to `article_urls`, and
 * the alternative was hand-copying three calls into a second file. That is the
 * same shape as the seed computing `content_hash` its own way, which disagreed
 * with the poller on 15 of 124 articles and was invisible until the next poll.
 */
export function articleUrlHash(url: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  const key = canonicalUrl(url);
  return key === null ? null : sha(contentHash(key, ""));
}

/**
 * The hashes an item resolves on, or null if it cannot be keyed at all.
 *
 * `guid_hash` is scoped to the feed by the index, so the raw guid is hashed
 * without the feed id — two publishers choosing the same string stay separate
 * because the INDEX is `(feed_id, guid_hash)`.
 */
function keysFor(item: RawItem): {
  // `Uint8Array<ArrayBuffer>` rather than bare `Uint8Array`: the batched
  // lookups bind these into `bytea[]` parameters, and `ArrayBufferLike`
  // includes `SharedArrayBuffer`, which those signatures reject.
  guidHash: Uint8Array<ArrayBuffer> | null;
  urlHash: Uint8Array<ArrayBuffer>;
  url: string;
} | null {
  const key = canonicalUrl(item.url);
  if (key === null) {
    // No keyable URL. A titled item can still be identified by rung 3, so it
    // is keyed on its content hash standing in for the URL — which keeps the
    // NOT NULL column satisfied without inventing an address.
    if (!item.title || item.title.trim() === "") return null;
    const stand = contentHash(item.title, item.contentHtml ?? item.summaryHtml ?? "");
    return {
      guidHash: item.guid ? sha(contentHash(item.guid, "")) : null,
      urlHash: sha(stand),
      url: item.url ?? "",
    };
  }
  return {
    guidHash: item.guid ? sha(contentHash(item.guid, "")) : null,
    /*
     * THE RAW URL, not `key`. The helper canonicalises what it is given, so
     * handing it the already-canonical `key` canonicalises twice — and the
     * canonical form has no scheme, so the second pass returns null and the
     * non-null assertion made that a lie. 57 tests failed on a `urlHash` of
     * null reaching `Buffer.from`.
     *
     * Equivalent by construction: `key` IS `canonicalUrl(item.url)`, and it
     * has already been checked non-null above, so this cannot be null here.
     */
    urlHash: articleUrlHash(item.url)!,
    url: item.url ?? key,
  };
}

/** Plain text for the content hash, from whichever body the feed sent. */
function bodyTextOf(item: RawItem): string {
  return item.contentHtml ?? item.summaryHtml ?? "";
}

/**
 * Resolves and writes one item.
 *
 * Returns null when the item has no identity at all — dropped and counted,
 * never given an index-derived id, which is the one choice that GUARANTEES
 * duplicates because the position changes on the next poll (§6.3).
 */
type KnownMaps = {
  byUrl: Map<string, UrlMatch>;
  byGuid: Map<string, bigint>;
  byContent: Map<string, bigint>;
};

/*
 * Two overloads so `"capped"` only appears where it can actually happen.
 *
 * A caller that does not pass `allowInsert` cannot be refused an insert, and
 * every such caller would otherwise have to narrow a case it never sees.
 */
export async function resolveAndWrite(
  feed: FeedTrust,
  item: RawItem,
  now: Date,
  known?: KnownMaps,
): Promise<Resolution | null>;
export async function resolveAndWrite(
  feed: FeedTrust,
  item: RawItem,
  now: Date,
  known: KnownMaps | undefined,
  allowInsert: boolean,
): Promise<Resolution | "capped" | null>;
export async function resolveAndWrite(
  feed: FeedTrust,
  item: RawItem,
  now: Date,
  known?: KnownMaps,
  /**
   * False once the per-poll insert cap is spent (N7).
   *
   * The cap stops INSERTS, not the poll. A merge updates an article that
   * already exists, so it adds nothing to the unread count and is exactly the
   * work worth finishing — a genuine revision arriving in the same poll as a
   * flood must not be silently dropped. Skipping the whole item instead was a
   * real mismatch between this code and its own comment.
   */
  allowInsert = true,
): Promise<Resolution | "capped" | null> {
  const resolution = await resolve(feed, item, now, known, allowInsert);
  if (resolution === null || resolution === "capped") return resolution;

  /*
   * THIS FEED delivered this article — recorded for every resolution, not only
   * for inserts.
   *
   * That is the whole point of the table. Rung 2 is global, so the second feed
   * to carry a story MERGES rather than inserting, and `articles.feed_id` keeps
   * naming the first feed. If arrivals were only written on insert, the second
   * feed would never be recorded anywhere: Appendix E's "also in 2 feeds" panel would
   * always say one, and a feed-scoped list would hide an article that feed
   * genuinely carries.
   */
  // `item.url` and not the canonical key: the panel strikes through what
  // canonicalisation discarded, so it needs the address as published. Null for
  // an item the feed published with no link at all (§6.3).
  await recordArrival(resolution.articleId, feed.id, item.url);
  return resolution;
}

async function resolve(
  feed: FeedTrust,
  item: RawItem,
  now: Date,
  /**
   * Pre-resolved `url_hash` -> `article_id`, from one query for the whole poll.
   *
   * §4 step 8 asks for one batched write per feed, and round trips are why: a
   * lookup per item is one network wait per item before any work happens, and
   * §6.4's budget is 240 seconds for TWENTY-FIVE feeds. When absent, the
   * per-item lookup is used — which is what a single-item call wants.
   */
  known?: KnownMaps,
  allowInsert = true,
): Promise<Resolution | "capped" | null> {
  const keys = keysFor(item);
  if (keys === null) return null;

  const text = bodyTextOf(item);
  const write: ArticleWrite = {
    feedId: feed.id,
    guidHash: keys.guidHash,
    url: keys.url,
    urlHash: keys.urlHash,
    contentHash: sha(contentHash(item.title, text)),
    normVersion: NORM_VERSION,
    title: item.title?.trim() || "(untitled)",
    author: item.author,
    // An undated item is dated when we first saw it. `null` is not an option —
    // the column is NOT NULL and every list orders on it — and `now()` at
    // least never moves once the row exists.
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : now,
    summaryHtml: item.summaryHtml,
    contentHtml: item.contentHtml,
    textLen: text.length === 0 ? null : text.length,
  };

  // Is rung 1 live for this feed? See `trustsGuids`.
  const trustGuid = trustsGuids(feed);

  /*
   * THE LADDER, in §6.1's order: guid, then url, then content.
   *
   * Rungs 1 and 2 are ROUTED by lookups and GUARANTEED by constraints. §6.1
   * forbids check-then-insert as the mechanism, and it still is not the
   * mechanism: two overlapping ticks can both miss these maps, and the
   * second one's `ON CONFLICT` resolves the race. The lookups only decide
   * which statement to run.
   *
   * Rung 2 HAS to be a lookup against `article_urls`, not a reliance on the
   * `articles_url` constraint alone, and that was a real bug:
   *
   *   When rung 1 merges two items that share a guid, the second item's
   *   address becomes an ALIAS in `article_urls` — it is not any row's current
   *   `articles.url_hash`. So the constraint cannot catch a later item at that
   *   address, and it inserted a duplicate. Two corpus items did exactly that
   *   once their guids churned, which is how it surfaced.
   *
   * The guid lookup runs FIRST so a MOVED article — same guid, new address —
   * still resolves to its existing row rather than becoming a second one.
   */
  const guidHex = keys.guidHash ? Buffer.from(keys.guidHash).toString("hex") : null;
  const urlHex = Buffer.from(keys.urlHash).toString("hex");

  // RUNG 1 — the publisher's own claim, when it is trusted.
  //
  // The lookup has to happen HERE even without the batched maps. Leaving it to
  // the upsert's `ON CONFLICT` put rung 1 LAST, after rung 3 — so a moved
  // article whose body had not changed resolved by CONTENT, and two articles
  // that legitimately share a title and opening text could merge ahead of the
  // publisher's own explicit claim.
  if (trustGuid && keys.guidHash !== null && guidHex !== null) {
    const existing = known
      ? (known.byGuid.get(guidHex) ?? null)
      : await findByGuidHash(feed.id, keys.guidHash);
    if (existing !== null) {
      const outcome = await mergeInto(existing, write);
      await recordUrl(existing, keys.urlHash, keys.url);
      return { articleId: existing, rung: "guid", revised: outcome.revised };
    }
  }

  // RUNG 2 — the canonical address, GLOBALLY, including addresses an article
  // has moved away from.
  {
    const existing = known
      ? (known.byUrl.get(urlHex)?.articleId ?? null)
      : await findByUrlHash(keys.urlHash);
    if (existing !== null) {
      const outcome = await mergeInto(existing, write);
      await recordUrl(existing, keys.urlHash, keys.url);
      return { articleId: existing, rung: "url", revised: outcome.revised };
    }
  }

  // RUNG 3 — content equality, scoped to the feed.
  //
  // Checked BEFORE the write, not as an error fallback: with a new guid and a
  // new address the insert SUCCEEDS, so there is no exception to catch. That
  // was a real bug — rung 3 never fired on the one case it exists for.
  //
  // Scoped to the feed because globally, a syndicated wire story would
  // collapse on text alone, which is a clustering decision P2 makes
  // deliberately and this rung must not make by accident.
  {
    const contentHex = Buffer.from(write.contentHash).toString("hex");
    const existing = known
      ? (known.byContent.get(contentHex) ?? null)
      : await findByContentHash(feed.id, write.contentHash);
    if (existing !== null) {
      const outcome = await mergeInto(existing, write);
      await recordUrl(existing, keys.urlHash, keys.url);
      return { articleId: existing, rung: "content", revised: outcome.revised };
    }
  }

  /*
   * No rung matched, so this is new — and NEW is what the cap refuses (N7).
   *
   * Every merge above has already run, which is the point: one bad CMS deploy
   * can republish an archive with fresh guids, and the cap stops that flooding
   * the unread count with thousands of rows nobody asked for. It does not stop
   * a revision in the same poll from being applied, because a merge adds
   * nothing to that count.
   *
   * Refused rather than queued. The remaining items are still in the feed on
   * the next poll, so a cap that drops them loses nothing permanently — and
   * the alternative, a buffer that drains over later polls, would hide the
   * flood from the operator the alert is meant to reach.
   */
  if (!allowInsert) return "capped";

  // The upsert is still an UPSERT, because a concurrent tick may have inserted
  // it since the lookups above.
  if (trustGuid && write.guidHash !== null) {
    try {
      const outcome = await upsertByGuid(write);
      return {
        articleId: outcome.id,
        rung: outcome.inserted ? null : "guid",
        revised: outcome.revised,
      };
    } catch (error) {
      // A new guid at an address another row already holds: the GLOBAL
      // `articles_url` constraint refused it, which IS rung 2 firing. The
      // constraint is the arbiter and the error is how it reports.
      if (!isUrlCollision(error)) throw error;
      const existing = await findByUrlHash(keys.urlHash);
      if (existing === null) throw error;
      const outcome = await mergeInto(existing, write);
      return { articleId: existing, rung: "url", revised: outcome.revised };
    }
  }

  try {
    const outcome = await upsertByUrl(write);
    return {
      articleId: outcome.id,
      rung: outcome.inserted ? null : "url",
      revised: outcome.revised,
    };
  } catch (error) {
    /*
     * The GUID constraint refused it — the one failure this statement can
     * actually hit, and it used to abort the poll.
     *
     * `upsertByUrl` conflicts on `url_hash`, so a URL collision is HANDLED
     * rather than thrown. What throws is `articles_guid`: this path runs when
     * the feed's guids are not trusted, so rung 1 did not route — but the
     * partial unique index does not know about trust, and an item repeating a
     * guid at a NEW address is refused.
     *
     * This catch used to be a rung-3 fallback with no error check at all. Rung
     * 3 became a pre-check before the write, which left the fallback dead for
     * its own case and live for this one: the content lookup found nothing and
     * rethrew, so EVERY feed with fewer than three clean polls — which is
     * every new feed — could lose an entire poll to one repeated guid.
     *
     * Resolved as rung "guid" because that is what the constraint decided. The
     * index is the arbiter and the error is how it reports (§6.1); an
     * untrusted feed still cannot hold two rows for one guid, whatever the
     * trust flag says.
     */
    if (!isGuidCollision(error) || keys.guidHash === null) throw error;
    const existing = await findByGuidHash(feed.id, keys.guidHash);
    if (existing === null) throw error;
    const outcome = await mergeInto(existing, write);
    // The address, which is NEW here — that is why the insert was attempted at
    // all. Every other resolution records it; this path used to be the one
    // that did not, so a later edit at that address inserted a duplicate.
    await recordUrl(existing, keys.urlHash, keys.url);
    return { articleId: existing, rung: "guid", revised: outcome.revised };
  }
}

/**
 * Ingests a feed's normalised items, in order, applying the cap.
 *
 * Serial rather than parallel, deliberately: §6.4 puts HTTP work at a
 * concurrency of 6 and DATABASE work at 1, because the sweep's limit is the
 * connection pool, not the CPU.
 */
export async function ingestItems(
  feed: FeedTrust,
  items: RawItem[],
  now: Date = new Date(),
): Promise<{ counters: LadderCounters; resolutions: Resolution[] }> {
  const counters = emptyCounters();
  const resolutions: Resolution[] = [];
  let inserted = 0;

  /*
   * ONE pre-check query for the whole poll, not one per item.
   *
   * The addresses are computed twice (here and in `resolveAndWrite`), which is
   * cheap and pure, and keeps the per-item path usable on its own.
   */
  const keyed = items.map((item) => keysFor(item));
  const known = {
    // ALWAYS loaded, trusted guids or not: see the note in `resolveAndWrite`
    // about aliases in `article_urls` that no constraint can catch.
    byUrl: await findManyByUrlHash(keyed.flatMap((k) => (k === null ? [] : [k.urlHash]))),
    /*
     * ALSO always loaded, and that is a change with a reason.
     *
     * It used to be `trusted ? … : new Map()`, which made the guid invisible on
     * exactly the feeds whose guids are being judged. An untrusted feed then
     * merged every re-polled item at rung 2, so §6.1's
     * `merged_by_url / items_seen` read 1.0 for a perfectly well-behaved
     * publisher — and a literal reading of the detector would have flagged
     * every new feed `guid_unstable` on its third poll, permanently.
     *
     * Loading it always costs one query per poll and lets `guidAgreed` /
     * `guidChurned` be measured whether or not rung 1 is ROUTING. Trust is
     * earned on that, not on the collapse rate.
     */
    byGuid: await findManyByGuidHash(
      feed.id,
      keyed.flatMap((k) => (k === null || k.guidHash === null ? [] : [k.guidHash])),
    ),
    // Rung 3's lookup, which has no constraint behind it and so must run
    // before the write rather than after a failure. Keyed off `keyed` so an
    // item with no identity at all contributes nothing here either.
    byContent: await findManyByContentHash(
      feed.id,
      items.flatMap((item, i) =>
        keyed[i] === null ? [] : [sha(contentHash(item.title, bodyTextOf(item)))],
      ),
    ),
  };

  for (const [index, item] of items.entries()) {
    counters.itemsSeen += 1;

    /*
     * Stop INSERTING, not stop reading.
     *
     * The item is still resolved and still merged if a rung matches — merges
     * update articles that already exist and so add nothing to the unread
     * count the cap is protecting. Only a NEW row is refused, inside
     * `resolve`, which reports back as "capped".
     *
     * Skipping the item outright was what this used to do, and it dropped a
     * genuine revision arriving in the same poll as a flood.
     */
    const allowInsert = inserted < INSERT_CAP_PER_POLL;

    const resolution = await resolveAndWrite(feed, item, now, known, allowInsert);
    if (resolution === null) {
      counters.droppedNoIdentity += 1;
      continue;
    }
    if (resolution === "capped") {
      counters.capHit = true;
      counters.itemsCapped += 1;
      continue;
    }

    resolutions.push(resolution);
    if (resolution.rung === null) {
      counters.itemsNew += 1;
      inserted += 1;
    } else if (resolution.rung === "guid") counters.mergedByGuid += 1;
    else if (resolution.rung === "url") counters.mergedByUrl += 1;
    else counters.mergedByContent += 1;

    if (resolution.revised) counters.revised += 1;

    /*
     * THE TRUST SIGNAL — did the publisher's guid agree with the row we matched?
     *
     * Only asked of items that MATCHED something. A new article has nothing to
     * agree with, and counting it either way would make a feed's score depend
     * on how much it published rather than on whether its identifiers hold
     * still.
     *
     * An item with no guid at all is also skipped. A publisher that never
     * promised an identifier has not broken one — §6.3 keeps those feeds
     * working through rungs 2 and 3, and they simply never earn rung 1.
     */
    if (resolution.rung !== null) {
      const keys = keyed[index];
      const guidHex =
        keys?.guidHash === null || keys?.guidHash === undefined
          ? null
          : Buffer.from(keys.guidHash).toString("hex");
      const urlHex = keys === null ? "" : Buffer.from(keys.urlHash).toString("hex");
      if (guidHex !== null && ownsMatchedRow(feed.id, resolution, known, urlHex)) {
        const claimed = known.byGuid.get(guidHex) ?? null;
        if (claimed === resolution.articleId) counters.guidAgreed += 1;
        else counters.guidChurned += 1;
      }
    }
  }

  return { counters, resolutions };
}
