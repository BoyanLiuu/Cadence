import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";

import { corpus } from "../../../test/fixtures/feeds/manifest";
import { ingestItems, type FeedTrust } from "./dedupe";
import { normalize } from "./normalize";
import { parse } from "./parse";

/*
 * THE TEST THAT MATTERS.
 *
 * Ingest all 31 corpus bodies, ingest them again, and assert the second pass
 * inserts ZERO rows. Then mutate every guid to a fresh value, append a
 * tracking parameter to every link, re-ingest, and still get zero.
 *
 * It is simultaneously the parser test, the normaliser test, the ladder test
 * and the idempotency test — and it is the only test that catches a regression
 * in `canonical-url.ts`, where a bug writes a PERMANENT duplicate that no
 * later fix removes on its own. §6.1: the rows are already in the table and
 * some are already read.
 *
 * Writes, so it needs `CADENCE_DB_WRITE_TESTS=1` (`pnpm test:db`): the Supabase
 * project is shared with the workspace's other apps and `pnpm check` stays
 * read-only.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;
const DIR = join(__dirname, "../../../test/fixtures/feeds");

/**
 * Every corpus body that parses, as normalised items — except the bulk one.
 *
 * `14-five-hundred-items.xml` is excluded deliberately. Its 500 items are six
 * times the rest of the corpus combined, which made this suite take eleven
 * minutes AND made the per-poll insert cap fire inside the headline test — so
 * "the second pass inserted nothing" would have been partly the CAP talking
 * rather than the ladder. Volume is `insert-cap.test.ts`'s subject; this
 * suite's subject is the corpus's VARIETY.
 */
const BULK_FIXTURE = "14-five-hundred-items.xml";

function corpusItems(feedUrl: string) {
  const out = [];
  for (const fixture of corpus) {
    if (fixture.file === BULK_FIXTURE) continue;
    const bytes = new Uint8Array(readFileSync(join(DIR, fixture.file)));
    const parsed = parse(bytes, fixture.contentType);
    if (!parsed.ok) continue;
    const { items } = normalize(parsed.items, {
      xmlBase: parsed.xmlBase,
      siteUrl: parsed.siteUrl,
      feedUrl: fixture.feedUrl,
    });
    out.push(...items);
  }
  void feedUrl;
  return out;
}

/*
 * 180s per test. Each pass is ~85 items and one round trip each against a
 * remote Postgres; the default 5s is a budget for in-memory work. This is the
 * honest cost of testing the ladder against a real database rather than a
 * mock, and §6.4's own budget is 240s for twenty-five feeds.
 */
describeDb("ingesting the corpus twice", { timeout: 180_000 }, () => {
  let feedId: bigint;
  let trust: FeedTrust;

  beforeAll(async () => {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
      VALUES ('https://parse-twice.example/feed',
              decode(md5(random()::text), 'hex'),
              'Parse twice probe', 3, 'active')
      RETURNING id
    `;
    feedId = rows[0].id;
    // `cleanPolls: 3` means the guids ARE trusted, so rung 1 is live. That is
    // the harder case: the pre-check would otherwise mask a canonicalisation
    // bug by catching everything at rung 2.
    trust = { id: feedId, guidUnstable: false, cleanPolls: 3, guidTrustOverride: "auto" };
  });

  afterAll(async () => {
    if (feedId !== undefined) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ${feedId}`;
    }
    await prisma.$disconnect();
  });

  it("inserts on the first pass and NOTHING on the second", async () => {
    const items = corpusItems("https://parse-twice.example/feed");
    expect(items.length).toBeGreaterThan(20);

    const first = await ingestItems(trust, items);
    expect(first.counters.itemsNew).toBeGreaterThan(0);

    const second = await ingestItems(trust, items);
    // THE ASSERTION. Anything other than zero is a duplicate that no later fix
    // removes without the replay in db/merge.ts.
    expect(second.counters.itemsNew).toBe(0);
    expect(second.counters.itemsSeen).toBe(first.counters.itemsSeen);

    const total = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}
    `;
    expect(Number(total[0].n)).toBe(first.counters.itemsNew);
  });

  it("inserts nothing when every guid is replaced", async () => {
    // The adversarial case §6.1 describes: a static-site generator that bakes
    // a build timestamp into the guid, so every poll looks like a full
    // re-publication. Rung 1 passes CLEANLY — these genuinely are new guids —
    // and rung 2 has to be what saves it.
    const items = corpusItems("https://parse-twice.example/feed");
    const before = await countArticles(feedId);

    const churned = items.map((item, i) => ({
      ...item,
      guid: `rebuilt-${Date.now()}-${i}`,
    }));
    const result = await ingestItems(trust, churned);

    expect(result.counters.itemsNew).toBe(0);
    expect(result.counters.mergedByUrl).toBeGreaterThan(0);
    expect(await countArticles(feedId)).toBe(before);
  });

  it("inserts nothing when every link gains a tracking parameter", async () => {
    // The canonicaliser's job, end to end. If `utm_source` stopped being
    // stripped, every one of these would be a new row.
    const items = corpusItems("https://parse-twice.example/feed");
    const before = await countArticles(feedId);

    const tagged = items.map((item) => ({
      ...item,
      url:
        item.url === null
          ? null
          : `${item.url}${item.url.includes("?") ? "&" : "?"}utm_source=test`,
    }));
    const result = await ingestItems(trust, tagged);

    expect(result.counters.itemsNew).toBe(0);
    expect(await countArticles(feedId)).toBe(before);
  });

  it("inserts nothing when the guid is replaced AND the link is tagged", async () => {
    // Both at once, which is the demo the plan describes.
    const items = corpusItems("https://parse-twice.example/feed");
    const before = await countArticles(feedId);

    const both = items.map((item, i) => ({
      ...item,
      guid: `rebuilt-again-${Date.now()}-${i}`,
      url:
        item.url === null
          ? null
          : `${item.url}${item.url.includes("?") ? "&" : "?"}utm_source=test&fbclid=zz`,
    }));
    const result = await ingestItems(trust, both);

    expect(result.counters.itemsNew).toBe(0);
    expect(await countArticles(feedId)).toBe(before);
  });

  it("inserts nothing when the scheme changes, as a TLS migration does", async () => {
    // §6.1 singles this out: the scheme is DROPPED from the key rather than
    // rewritten, so a publisher moving to https must not re-publish their
    // entire archive.
    const items = corpusItems("https://parse-twice.example/feed");
    const before = await countArticles(feedId);

    const switched = items.map((item) => ({
      ...item,
      url: item.url === null ? null : item.url.replace(/^https:/, "http:"),
    }));
    const result = await ingestItems(trust, switched);

    expect(result.counters.itemsNew).toBe(0);
    expect(await countArticles(feedId)).toBe(before);
  });

  it("DOES insert a genuinely new article, so the test is not vacuous", async () => {
    // Everything above asserts zero. Without this, a ladder that merged
    // EVERYTHING into one row would pass the whole suite.
    const before = await countArticles(feedId);
    const result = await ingestItems(trust, [
      {
        guid: `genuinely-new-${Date.now()}`,
        url: `https://parse-twice.example/brand-new-${Date.now()}`,
        title: `A genuinely new article ${Date.now()}`,
        author: "Someone",
        publishedAt: new Date().toISOString(),
        contentHtml: "<p>Text nobody has seen before.</p>",
        summaryHtml: null,
        xmlBase: null,
      },
    ]);

    expect(result.counters.itemsNew).toBe(1);
    expect(await countArticles(feedId)).toBe(before + 1);
  });
});

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}
  `;
  return Number(rows[0].n);
}
