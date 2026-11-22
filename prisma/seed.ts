import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

import type { FetchLogEntry } from "../src/lib/types";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  SAMPLE_NOW,
  articles,
  feeds,
  folders,
  sampleUser,
  subscriptions,
  ticks,
} from "../src/lib/fixtures";
import { canonicalUrl } from "../src/lib/ingest/canonical-url";
import { contentHash } from "../src/lib/ingest/content-hash";

/*
 * The M1 fixtures, written through the REAL schema.
 *
 * So the seeded database and the fixture corpus are the same data — which is
 * what makes `service-parity.test.ts` meaningful: it compares two
 * implementations answering the same questions about the same articles, and a
 * difference is a bug in one of them rather than a difference in the input.
 *
 * The hashes are computed here with the SAME functions ingestion will use
 * (M3's `canonicalUrl` and `contentHash`), not invented. A seed that made up
 * its own keys would seed a database the ladder could never have produced, and
 * the constraint tests would be proving something about fiction.
 */

/*
 * DATABASE_URL, not DIRECT_URL, and the order matters.
 *
 * DIRECT_URL carries `?schema=cadence` for the migrate CLI. Prisma reads that
 * as the connection's DEFAULT schema and so emits UNQUALIFIED SQL — which then
 * resolves against the pg driver's real `search_path` (`public, extensions`,
 * because `?schema=` is a Prisma concept libpq ignores) and fails with
 * `relation "feeds" does not exist`.
 *
 * DATABASE_URL has no `?schema=`, so the generated client qualifies every
 * table as `cadence.feeds`. The schema param is stripped from any fallback for
 * the same reason.
 */
/** The URL with any `schema` query parameter removed, structurally. */
function withoutSchemaParam(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    // Not parseable as a URL. Returned untouched rather than mangled — a
    // regex here ate the leading `?`, so `?schema=cadence&sslmode=require`
    // became a database named `postgres&sslmode=require`.
    return url;
  }
}

const connectionString = withoutSchemaParam(process.env.DATABASE_URL ?? process.env.DIRECT_URL);
if (!connectionString) {
  throw new Error("DATABASE_URL or DIRECT_URL must be set to seed. See .env.example.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * Node's `Buffer` as the `Uint8Array<ArrayBuffer>` Prisma 7 expects.
 *
 * A `Buffer` is typed `Uint8Array<ArrayBufferLike>`, which may be backed by a
 * SharedArrayBuffer and so is not assignable to a `Bytes` column. Copying is
 * the honest fix; casting would hide a real difference.
 */
const bytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(buffer);

const sha256 = (value: string) => bytes(createHash("sha256").update(value, "utf8").digest());

/** The key rung 2 will compute for this address, or a fallback for a bad one. */
function urlHashOf(url: string): Uint8Array<ArrayBuffer> {
  const key = canonicalUrl(url);
  // `canonicalUrl` refuses an address it cannot key. The ballast fixtures use
  // `example.invalid`, which is keyable, so this only guards the unexpected —
  // and hashing the raw URL keeps the row insertable rather than dropping it.
  return sha256(key ?? url);
}

/** Rung 1's key: the publisher's guid, scoped to the feed by the index. */
function guidHashOf(article: { id: number; feedId: number }): Uint8Array<ArrayBuffer> {
  // The fixtures carry no guids — they are a reader's view, not a feed body.
  // A synthetic one per article keeps rung 1 exercised, and is stable so
  // re-seeding is idempotent.
  return sha256(`fixture:${article.feedId}:${article.id}`);
}

/** Plain text of a fixture body, for the content hash. */
function bodyText(body: { p?: string; h?: string; li?: string[] }[]): string {
  return body
    .map((block) =>
      "p" in block && block.p
        ? block.p
        : "h" in block && block.h
          ? block.h
          : "li" in block && block.li
            ? block.li.join(" ")
            : "",
    )
    .join(" ");
}

async function main() {
  // Order matters: children before parents, or the foreign keys refuse.
  await prisma.fetchLog.deleteMany();
  await prisma.summary.deleteMany();
  await prisma.userArticle.deleteMany();
  await prisma.articleUrl.deleteMany();
  await prisma.article.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.folder.deleteMany();
  await prisma.feed.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      id: sampleUser.id,
      email: sampleUser.email,
      name: sampleUser.name,
      tz: sampleUser.tz,
      aiEnabled: sampleUser.aiEnabled,
    },
  });

  for (const folder of folders) {
    // The corpus carries one folder belonging to another reader, so the
    // scoping tests have something to fail against. It needs its owner.
    if (folder.userId !== sampleUser.id) {
      await prisma.user.upsert({
        where: { id: folder.userId },
        update: {},
        create: {
          id: folder.userId,
          email: `${folder.userId}@example.invalid`,
          name: "Someone else",
        },
      });
    }
    await prisma.folder.create({
      data: {
        id: BigInt(folder.id),
        userId: folder.userId,
        name: folder.name,
        position: folder.position,
      },
    });
  }

  for (const feed of feeds) {
    await prisma.feed.create({
      data: {
        id: BigInt(feed.id),
        feedUrl: feed.feedUrl,
        urlHash: urlHashOf(feed.feedUrl),
        siteUrl: feed.siteUrl,
        title: feed.title,
        format: feed.format,
        status: feed.status,
        fetchIntervalS: feed.intervalS,
        medianPostGapS: feed.medianGapS,
        declaredTtlS: feed.declaredTtlS,
        unchangedPolls: feed.unchangedPolls,
        consecutiveFailures: feed.consecutiveFailures,
        nextFetchAt: feed.nextFetchAt ? new Date(feed.nextFetchAt) : null,
        lastSuccessAt: feed.lastSuccessAt ? new Date(feed.lastSuccessAt) : null,
        lastErrorAt: feed.lastError ? new Date(feed.lastError.at) : null,
        lastErrorCode: feed.lastError ? String(feed.lastError.code) : null,
        lastErrorText: feed.lastError?.text ?? null,
        deadAt: feed.deadAt ? new Date(feed.deadAt) : null,
        notFeedAt: feed.notFeedAt ? new Date(feed.notFeedAt) : null,
        firstFailureAt: feed.firstFailureAt ? new Date(feed.firstFailureAt) : null,
        guidUnstable: feed.guidUnstable,
        guidUnstableSince: feed.guidUnstableSince ? new Date(feed.guidUnstableSince) : null,
        // `null` in the domain means "has proved itself", which is 3 or more.
        cleanPolls: feed.cleanPolls ?? 3,
      },
    });
  }

  for (const sub of subscriptions) {
    await prisma.subscription.create({
      data: {
        userId: sub.userId,
        feedId: BigInt(sub.feedId),
        folderId: sub.folderId === null ? null : BigInt(sub.folderId),
        customTitle: sub.customTitle,
        fullTextMode: sub.fullTextMode,
        resurfaceOnRevision: sub.resurfaceOnRevision,
        createdAt: new Date(sub.subscribedAt),
      },
    });
  }

  for (const article of articles) {
    const text = bodyText(article.body as { p?: string; h?: string; li?: string[] }[]);
    const urlHash = urlHashOf(article.url);

    await prisma.article.create({
      data: {
        id: BigInt(article.id),
        feedId: BigInt(article.feedId),
        guidHash: guidHashOf(article),
        url: article.url,
        urlHash,
        contentHash: bytes(contentHash(article.title, text)),
        title: article.title,
        author: article.author || null,
        publishedAt: new Date(article.publishedAt),
        fetchedAt: new Date(article.fetchedAt),
        summaryHtml: article.summary || null,
        contentHtml: text || null,
        textLen: text.length,
        extractStatus: article.extractStatus,
        revisedAt: article.revisedAt ? new Date(article.revisedAt) : null,
        revisionCount: article.revisionCount,
        // Every address this article has ever been reachable at (§6.1).
        urls: { create: { urlHash, url: article.url } },
        /*
         * The arrival, which every list now matches on.
         *
         * `articles.feed_id` names only the feed that saw an article FIRST,
         * because rung 2 is global — so the lists read `article_feeds` instead,
         * and a seeded article with no arrival row is invisible in all of them.
         * The fixtures have no syndicated article yet, so this is exactly one
         * row per article; it still has to exist.
         */
        arrivals: {
          create: (
            article.arrivals ?? [
              { feedId: article.feedId, url: article.url, at: article.fetchedAt },
            ]
          ).map((arrival) => ({
            feedId: BigInt(arrival.feedId),
            // The RAW address that feed delivered, which is what Appendix E's panel
            // strikes through. The two syndicated fixtures carry different
            // tracking tags per feed, and that difference IS the demo.
            url: arrival.url,
            firstSeenAt: new Date(arrival.at),
          })),
        },
      },
    });

    // Written ONLY where the reader has touched it. A missing row means unread,
    // and seeding a row per article would defeat the mechanism (§6.2).
    if (article.readAt !== null || article.savedAt !== null) {
      await prisma.userArticle.create({
        data: {
          userId: sampleUser.id,
          articleId: BigInt(article.id),
          readAt: article.readAt ? new Date(article.readAt) : null,
          savedAt: article.savedAt ? new Date(article.savedAt) : null,
          wasReadAt: article.wasReadAt ? new Date(article.wasReadAt) : null,
        },
      });
    }
  }

  /*
   * THE FETCH LOG, rebased onto the current clock.
   *
   * The health screen's per-day figures come from a `groupBy` over `fetch_log`
   * rows dated `>= start of UTC day`, and every fixture log entry carries a
   * FROZEN date — the corpus's `SAMPLE_NOW` is 2026-11-12T09:40Z. Written at
   * their literal dates, none of them has been "today" since the corpus was
   * authored, so the database path showed **0 for every counter on every
   * feed**. For five milestones. It survived because an all-empty health table
   * is a believable state rather than an obviously broken one, which is the
   * failure mode that screen can least afford.
   *
   * Restamping each entry at `Date.now()` is the wrong fix twice over: the
   * fixtures MODULE is frozen TypeScript that component tests read directly,
   * so moving only the seeded copies would make the two implementations
   * disagree on every date instead of just on these counters — and a tail
   * whose eight checks all share one instant is not a tail.
   *
   * So the whole log is shifted by a WHOLE NUMBER OF DAYS, which lands the
   * corpus's own "today" on the real today and leaves every relative age
   * intact: feed 5's six checks still read one per day going back six days,
   * and feed 8's failures still sit a fortnight back.
   *
   * The fixtures turn out to be exactly consistent under that shift. For nine
   * of the twelve feeds the entries dated 11-12 account for the whole of
   * `today` — rows, 304s, failures and item sums alike. The other three are
   * checked often enough that their day is bigger than the tail shows (feed 1
   * shows 8 of 39 checks), and only the REMAINDER is synthesised, below.
   */
  const startOfUtcDay = (d: Date) => {
    const start = new Date(d);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  };

  const corpusNow = new Date(SAMPLE_NOW);
  const corpusDayStart = startOfUtcDay(corpusNow);
  const startOfToday = startOfUtcDay(new Date());
  const dayShiftMs = startOfToday.getTime() - corpusDayStart.getTime();

  /*
   * Times inside the corpus's day are SQUEEZED into the part of today that has
   * actually elapsed, so no check is stamped in the future — a check dated
   * ahead of now would read as a clock problem on the one screen that exists
   * to be trusted. Seeding at 03:00 UTC maps the corpus's 00:00–09:40 onto
   * 00:00–03:00; seeding any time after 09:40 leaves the times as written.
   * Earlier days need no squeeze: a whole-day shift keeps them in the past.
   */
  const corpusElapsedMs = corpusNow.getTime() - corpusDayStart.getTime();

  /*
   * With a floor of one second, for the pathological case. Seeding in the first
   * instants of a UTC day leaves no room at all: the squeeze goes to zero, every
   * row today collapses onto midnight, and the tail's "newest first" becomes a
   * TIE that `take 8` resolves however the database feels — so the health screen
   * shows synthetic rows, which is the exact bug the rebasing exists to avoid.
   *
   * The cost is bounded and unobservable: inside the first second of a UTC day a
   * row can be stamped up to a second ahead of now, and is in the past before
   * anything renders it. The version of this that floored at a MINUTE is what
   * made that trade badly — a minute is long enough to show on screen.
   */
  const MIN_DAY_SPAN_MS = 1_000;
  const elapsedTodayMs = Math.max(MIN_DAY_SPAN_MS, Date.now() - startOfToday.getTime());
  const squeeze = Math.min(1, elapsedTodayMs / corpusElapsedMs);

  const rebase = (iso: string): Date => {
    const shifted = new Date(iso).getTime() + dayShiftMs;
    const intoDay = shifted - startOfToday.getTime();
    if (intoDay < 0) return new Date(shifted);
    if (intoDay > corpusElapsedMs) {
      // A fixture entry dated after the corpus's own "now" has no honest place
      // on a real clock: squeezing it would still land it in the future.
      throw new Error(`fixture log entry ${iso} is after SAMPLE_NOW (${SAMPLE_NOW})`);
    }
    return new Date(startOfToday.getTime() + Math.round(intoDay * squeeze));
  };

  const isNotModified = (code: FetchLogEntry["code"]) => code === 304;
  // Matches what the service counts as a failure: an error code, or a status
  // past 400. A non-numeric fixture code (`html`, `timeout`) becomes an
  // `error_code` below, so it counts here too.
  const isFailure = (code: FetchLogEntry["code"]) => typeof code !== "number" || code >= 400;

  for (const feed of feeds) {
    for (const entry of feed.log) {
      const numericCode = typeof entry.code === "number" ? entry.code : null;
      await prisma.fetchLog.create({
        data: {
          feedId: BigInt(feed.id),
          at: rebase(entry.at),
          statusCode: numericCode,
          errorCode: numericCode === null ? String(entry.code) : null,
          durationMs: entry.ms,
          itemsSeen: entry.itemsSeen,
          itemsNew: entry.itemsNew,
          mergedByGuid: entry.mergedByGuid,
          mergedByUrl: entry.mergedByUrl,
          mergedByContent: entry.mergedByContent,
          revised: entry.revised,
          /*
           * DERIVED from the rungs, not carried per entry.
           *
           * `guid_agreed` / `guid_churned` arrived in M8 and the fixture log
           * entries predate them. Rather than invent a value for all of them,
           * they use the relationship that holds for a TRUSTED feed: an item
           * matched at rung 1 agreed on its guid, and one matched at rung 2
           * did not — which is exactly why the collapse rate is the churn
           * signal once a feed is trusted (see `guid-trust.ts`).
           *
           * It is a derivation and not the real measurement, so it is right
           * for the fixture feeds and would be wrong for an UNTRUSTED one,
           * where everything matches at rung 2 whether the guids held or not.
           * The one fixture feed in that state has no log entries with items.
           *
           * `mergedByContent` is ignored, which production counts as churn — a
           * rung-3 match means the guid pointed nowhere. Harmless only because
           * every fixture entry has it at zero; a fixture that set it would
           * under-report churn here.
           */
          guidAgreed: entry.mergedByGuid,
          guidChurned: entry.mergedByUrl,
          note: entry.note ?? null,
        },
      });
    }
  }

  /*
   * THE REST OF TODAY, for the feeds whose day is bigger than their tail.
   *
   * `today` is an aggregate over every check since midnight; `log` is the
   * newest handful. On a feed checked every fifteen minutes those are very
   * different sizes — feed 1 shows 8 of 39 — so the unshown 31 have to exist
   * as rows or the counters read low, which on this screen is indistinguishable
   * from the ingestion having done less work than it did.
   *
   * Note which counters are ROWS and which are SUMS, because they are filled
   * differently: `checks` is a row count, `n304` counts rows whose status is
   * 304, `failed` counts rows with an error or a status past 400. The rest are
   * sums over the day's rows.
   *
   * Every shortfall is derived by subtraction and every one is checked, so a
   * fixture whose `today` block contradicts its own tail fails the seed by
   * name instead of quietly seeding a day that could not have happened.
   */
  for (const feed of feeds) {
    const t = feed.today;
    const todayEntries = feed.log.filter((entry) => rebase(entry.at) >= startOfToday);

    const sum = (pick: (entry: (typeof todayEntries)[number]) => number) =>
      todayEntries.reduce((total, entry) => total + pick(entry), 0);

    const short = (name: string, designed: number, shown: number) => {
      if (shown > designed) {
        throw new Error(
          `feed ${feed.id} (${feed.title}): today's log entries already carry ` +
            `${name} ${shown}, more than today.${name} ${designed}`,
        );
      }
      return designed - shown;
    };

    const missingChecks = short("checks", t.checks, todayEntries.length);
    const missing304 = short(
      "n304",
      t.n304,
      todayEntries.filter((e) => isNotModified(e.code)).length,
    );
    const missingFailed = short(
      "failed",
      t.failed,
      todayEntries.filter((e) => isFailure(e.code)).length,
    );
    const missingPlain = missingChecks - missing304 - missingFailed;
    if (missingPlain < 0) {
      throw new Error(
        `feed ${feed.id} (${feed.title}): ${missing304} unshown 304s plus ` +
          `${missingFailed} unshown failures exceed the ${missingChecks} unshown checks`,
      );
    }

    const sums = {
      itemsSeen: short(
        "seen",
        t.seen,
        sum((e) => e.itemsSeen),
      ),
      itemsNew: short(
        "new",
        t.new,
        sum((e) => e.itemsNew),
      ),
      mergedByGuid: short(
        "mergedByGuid",
        t.mergedByGuid,
        sum((e) => e.mergedByGuid),
      ),
      mergedByUrl: short(
        "mergedByUrl",
        t.mergedByUrl,
        sum((e) => e.mergedByUrl),
      ),
      mergedByContent: short(
        "mergedByContent",
        t.mergedByContent,
        sum((e) => e.mergedByContent),
      ),
      revised: short(
        "revised",
        t.revised,
        sum((e) => e.revised),
      ),
      // Derived from the rungs for the tail too — see the note above.
      guidAgreed: short(
        "guidAgreed",
        t.guidAgreed,
        sum((e) => e.mergedByGuid),
      ),
      guidChurned: short(
        "guidChurned",
        t.guidChurned,
        sum((e) => e.mergedByUrl),
      ),
    };
    const unplaceable = Object.entries(sums).filter(([, value]) => value > 0);
    if (missingPlain === 0 && unplaceable.length > 0) {
      // Only a successful check can carry items, so there is nowhere to put
      // these. Silently dropping them is how `seen` and `new` would read low.
      throw new Error(
        `feed ${feed.id} (${feed.title}): no unshown successful check to carry ` +
          unplaceable.map(([name, value]) => `${name} ${value}`).join(", "),
      );
    }
    if (missingChecks === 0) continue;

    /*
     * Placed BEFORE the oldest entry today's tail shows, so the tail stays the
     * tail: the health screen's recent checks and the tick timeline both read
     * newest-first off this table, and synthetic rows stamped later would push
     * the designed history off the end of the list.
     */
    const oldestShown = todayEntries.reduce(
      (oldest, entry) => Math.min(oldest, rebase(entry.at).getTime()),
      startOfToday.getTime() + elapsedTodayMs,
    );
    const window = oldestShown - startOfToday.getTime();
    const at = (i: number) =>
      new Date(startOfToday.getTime() + Math.round((window * (i + 1)) / (missingChecks + 1)));

    // Oldest first, and the item-bearing checks oldest of all, so what sits
    // nearest the visible tail is the 304s that dominate a quiet morning.
    let i = 0;
    for (let n = 0; n < missingPlain; n++, i++) {
      // The sums ride on the FIRST of them; the rest are empty 200s. Spreading
      // them evenly would need the totals to divide, and a fixture should not
      // have to be arithmetically convenient.
      const first = n === 0;
      await prisma.fetchLog.create({
        data: {
          feedId: BigInt(feed.id),
          at: at(i),
          statusCode: 200,
          durationMs: 180,
          ...(first ? sums : {}),
        },
      });
    }
    for (let n = 0; n < missingFailed; n++, i++) {
      await prisma.fetchLog.create({
        data: {
          feedId: BigInt(feed.id),
          at: at(i),
          statusCode: null,
          errorCode: "timeout",
          durationMs: 10_000,
        },
      });
    }
    for (let n = 0; n < missing304; n++, i++) {
      await prisma.fetchLog.create({
        data: { feedId: BigInt(feed.id), at: at(i), statusCode: 304, durationMs: 40 },
      });
    }
  }

  /*
   * Advance the sequences past the explicit ids above.
   *
   * Seeding with explicit ids does NOT move a BIGSERIAL's sequence, so it stays
   * at 1 — and the next insert that lets the database pick an id collides on
   * the primary key. That is every constraint test (which creates feeds without
   * ids) and every article ingestion will ever write.
   *
   * `setval` with the max, or 1 when the table is empty.
   */
  for (const table of ["feeds", "folders", "articles", "summaries", "fetch_log"]) {
    // SCHEMA-QUALIFIED. `$executeRawUnsafe` is passed through verbatim, and the
    // connection's search_path is `public, extensions` — only Prisma's
    // GENERATED queries know about `schemas = ["cadence"]`.
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('cadence.${table}', 'id'),
                     COALESCE((SELECT max(id) FROM cadence.${table}), 1))`,
    );
  }

  const counts = {
    users: await prisma.user.count(),
    feeds: await prisma.feed.count(),
    folders: await prisma.folder.count(),
    subscriptions: await prisma.subscription.count(),
    articles: await prisma.article.count(),
    articleUrls: await prisma.articleUrl.count(),
    // Reported because every list matches on this table. A zero here means a
    // seeded database that renders as empty, which is worth seeing at once
    // rather than debugging through the UI.
    articleFeeds: await prisma.articleFeed.count(),
    userArticles: await prisma.userArticle.count(),
    fetchLog: await prisma.fetchLog.count(),
  };
  console.log("seeded", counts, `(${ticks.length} tick fixtures are derived from fetch_log)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    await prisma.$disconnect();
    throw error;
  });
