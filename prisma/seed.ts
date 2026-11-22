import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

import { PrismaClient } from "../src/generated/prisma/client";
import { articles, feeds, folders, sampleUser, subscriptions, ticks } from "../src/lib/fixtures";
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

  // The fetch log, from each feed's fixture tail plus the tick fixtures.
  for (const feed of feeds) {
    for (const entry of feed.log) {
      const numericCode = typeof entry.code === "number" ? entry.code : null;
      await prisma.fetchLog.create({
        data: {
          feedId: BigInt(feed.id),
          at: new Date(entry.at),
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
