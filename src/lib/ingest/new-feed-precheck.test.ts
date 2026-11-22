import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { ingestItems, trustsGuids, type FeedTrust } from "./dedupe";
import { judgePoll } from "./guid-trust";

/*
 * What this suite is for: THE ORDERING TRAP, which §6.1 says "a first
 * implementation always omits".
 *
 * Flipping `guid_unstable` only stops FUTURE duplicates. By the time three
 * polls have proved a feed regenerates its guids, it has already inserted the
 * duplicates those three polls were made of — and they are permanent, because
 * the rows are real and some will have been read.
 *
 * So a brand-new feed must insert ZERO duplicates on its FIRST poll, before
 * anything has been learned about it. That is what the rung-2 pre-check is
 * for, and it is the promise the add-feed screen already makes to the reader:
 * "trusted slowly".
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A new feed's article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>Body text.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

/** `clean_polls = 0`: a feed nobody has learned anything about yet. */
async function makeNewFeed(): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://brandnew-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Brand new feed', 0, 'active')
    RETURNING id`;
  return { id: rows[0].id, guidUnstable: false, cleanPolls: 0, guidTrustOverride: "auto" };
}

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
  return Number(rows[0].n);
}

describe("a new feed does not route rung 1", () => {
  it("is untrusted at zero clean polls, and trusted at three", () => {
    const base = { id: BigInt(1), guidUnstable: false, guidTrustOverride: "auto" as const };
    expect(trustsGuids({ ...base, cleanPolls: 0 })).toBe(false);
    expect(trustsGuids({ ...base, cleanPolls: 2 })).toBe(false);
    expect(trustsGuids({ ...base, cleanPolls: 3 })).toBe(true);
  });

  it("never routes rung 1 once guid_unstable is set, however many clean polls", () => {
    // §6.1: once set it is skipped FOREVER. A feed that lies and then behaves
    // for three polls does not get rung 1 back automatically.
    expect(
      trustsGuids({
        id: BigInt(1),
        guidUnstable: true,
        cleanPolls: 99,
        guidTrustOverride: "auto",
      }),
    ).toBe(false);
  });

  it("honours an explicit override in both directions", () => {
    // The override is configuration, unlike the flag, which is learned.
    expect(
      trustsGuids({ id: BigInt(1), guidUnstable: true, cleanPolls: 0, guidTrustOverride: "guid" }),
    ).toBe(true);
    expect(
      trustsGuids({ id: BigInt(1), guidUnstable: false, cleanPolls: 99, guidTrustOverride: "url" }),
    ).toBe(false);
  });
});

describeDb("the rung-2 pre-check on a feed's FIRST poll", { timeout: 180_000 }, () => {
  const made: bigint[] = [];

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("inserts ZERO duplicates when a brand-new feed churns its guids mid-poll", async () => {
    /*
     * The trap, in its purest form: the SAME article twice in ONE poll, with a
     * different guid each time — which is what a feed re-rendered between two
     * reads of it looks like.
     *
     * Rung 1 cannot help: the guids genuinely differ, and the feed is untrusted
     * so rung 1 is not even routing. Only the rung-2 pre-check against
     * `article_urls` can collapse them, and it has to do so with NO learned
     * state, on the first poll this feed has ever had.
     */
    const feed = await makeNewFeed();
    made.push(feed.id);
    const url = `https://brandnew-${unique()}.example/the-one-article`;

    const { counters } = await ingestItems(feed, [
      item({ guid: `build-a-${unique()}`, url }),
      item({ guid: `build-b-${unique()}`, url }),
      item({ guid: `build-c-${unique()}`, url }),
    ]);

    expect(counters.itemsSeen).toBe(3);
    // ONE row, not three.
    expect(counters.itemsNew).toBe(1);
    expect(counters.mergedByUrl).toBe(2);
    expect(await countArticles(feed.id)).toBe(1);
  });

  it("inserts ZERO on a SECOND poll of a feed whose every guid changed", async () => {
    // The static-site-generator case across polls rather than within one. The
    // feed is still untrusted at this point, so again only rung 2 can save it.
    const feed = await makeNewFeed();
    made.push(feed.id);
    const items = Array.from({ length: 6 }, (_, i) =>
      item({
        guid: `first-${unique()}-${i}`,
        url: `https://brandnew-${unique()}.example/post-${i}`,
        title: `Post ${i} ${unique()}`,
        contentHtml: `<p>Body ${i}.</p>`,
      }),
    );

    const first = await ingestItems(feed, items);
    expect(first.counters.itemsNew).toBe(6);

    const churned = items.map((it, i) => ({ ...it, guid: `rebuilt-${unique()}-${i}` }));
    const second = await ingestItems(feed, churned);

    expect(second.counters.itemsNew).toBe(0);
    expect(second.counters.mergedByUrl).toBe(6);
    expect(await countArticles(feed.id)).toBe(6);
  });

  it("MEASURES guid churn on an untrusted feed, which is how trust is earned", async () => {
    /*
     * The bootstrap, and the reason `byGuid` is loaded even when rung 1 is not
     * routing.
     *
     * §6.1's detector is `merged_by_url / items_seen`. On an untrusted feed
     * rung 1 does not route, so EVERY re-polled item merges at rung 2 and that
     * rate is 1.0 — for a perfectly well-behaved publisher. Read literally it
     * would flag every new feed `guid_unstable` on its third poll, permanently,
     * which is the exact opposite of "trusted slowly".
     *
     * `guidAgreed` / `guidChurned` ask the question that actually matters:
     * did the publisher's guid point at the row we matched?
     */
    const feed = await makeNewFeed();
    made.push(feed.id);
    const items = Array.from({ length: 6 }, (_, i) =>
      item({
        guid: `stable-${unique()}-${i}`,
        url: `https://bootstrap-${unique()}.example/post-${i}`,
        title: `Bootstrap ${i} ${unique()}`,
        contentHtml: `<p>Body ${i}.</p>`,
      }),
    );

    await ingestItems(feed, items);
    // Re-polled UNCHANGED. The collapse rate will read 1.0 because rung 2 did
    // all the work — but every guid agreed, so the poll is clean.
    const { counters } = await ingestItems(feed, items);

    expect(counters.itemsNew).toBe(0);
    expect(counters.mergedByUrl).toBe(6);
    expect(counters.mergedByUrl / counters.itemsSeen).toBe(1);

    expect(counters.guidAgreed).toBe(6);
    expect(counters.guidChurned).toBe(0);
    expect(judgePoll(counters)).toBe("clean");
  });

  it("does NOT blame a feed for guids on rows ANOTHER feed owns", async () => {
    /*
     * The failure this check exists for, and the overlap is ordinary: a site's
     * main feed plus one of its category feeds, an aggregator, or the
     * syndication rung 2 exists to collapse.
     *
     * Rung 2 is GLOBAL while the guid map is scoped to `feed_id`. So feed B
     * matches feed A's articles at rung 2, finds nothing in its own guid map,
     * and looks like it churned every identifier it has — 100% on EVERY poll,
     * flagged `guid_unstable` on its third, and unable to recover, because
     * `mergeInto` never writes `guid_hash` and the row keeps A's identifier
     * forever. The health screen then tells the reader this publisher "changed
     * its ids on every build", which is simply false.
     *
     * A row another feed owns is therefore NOT JUDGED at all.
     */
    const feedA = await makeNewFeed();
    const feedB = await makeNewFeed();
    made.push(feedA.id, feedB.id);
    const host = `https://overlap-${unique()}.example`;
    const items = Array.from({ length: 6 }, (_, i) =>
      item({
        guid: `a-${unique()}-${i}`,
        url: `${host}/post-${i}`,
        title: `Overlap ${i} ${unique()}`,
        contentHtml: `<p>Body ${i}.</p>`,
      }),
    );

    // A publishes them first, so A owns every row.
    await ingestItems(feedA, items);

    // B carries the same six articles under its OWN guids.
    const bItems = items.map((it, i) => ({ ...it, guid: `b-${unique()}-${i}` }));
    const { counters } = await ingestItems(feedB, bItems);

    // Collapsed correctly: one row each, matched globally at rung 2.
    expect(counters.itemsNew).toBe(0);
    expect(counters.mergedByUrl).toBe(6);

    // THE ASSERTION: B is not scored at all on rows it does not own.
    expect(counters.guidChurned).toBe(0);
    expect(counters.guidAgreed).toBe(0);
    expect(judgePoll(counters)).toBe("unmeasured");
  });

  it("scores a CHURNING untrusted feed as dirty, on the same measure", async () => {
    // The negative half. Both polls look identical through the collapse rate;
    // only guid agreement tells them apart.
    const feed = await makeNewFeed();
    made.push(feed.id);
    const items = Array.from({ length: 6 }, (_, i) =>
      item({
        guid: `v1-${unique()}-${i}`,
        url: `https://dirty-${unique()}.example/post-${i}`,
        title: `Dirty ${i} ${unique()}`,
        contentHtml: `<p>Body ${i}.</p>`,
      }),
    );

    await ingestItems(feed, items);
    const churned = items.map((it, i) => ({ ...it, guid: `v2-${unique()}-${i}` }));
    const { counters } = await ingestItems(feed, churned);

    expect(counters.mergedByUrl / counters.itemsSeen).toBe(1);
    expect(counters.guidAgreed).toBe(0);
    expect(counters.guidChurned).toBe(6);
    expect(judgePoll(counters)).toBe("churned");
  });
});
