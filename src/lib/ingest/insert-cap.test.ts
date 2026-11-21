import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { emptyCounters, INSERT_CAP_PER_POLL, ingestItems, type FeedTrust } from "./dedupe";

/*
 * What this suite is for: the flood.
 *
 * One bad CMS deploy republishes an entire archive with fresh guids. Rung 1
 * passes cleanly — these genuinely ARE new guids — and if the addresses changed
 * too, so does rung 2. Without a cap, thousands of rows land in someone's
 * unread count in one tick, and the damage is NOT UNDOABLE: the rows are real,
 * some will have been read, and no later fix removes them without the replay in
 * `db/merge.ts`.
 *
 * ARCHITECTURE N7 puts the cap at 500 per poll, and the plan puts it in M7
 * rather than after the incident. The second half of the cap's contract matters
 * as much as the first: it stops INSERTS, not the poll. A merge updates an
 * article that already exists and adds nothing to the unread count, so a
 * genuine revision arriving in the same tick as a flood must still be applied.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "A republished article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>Body text.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

/** `n` genuinely distinct articles — distinct at every rung, so all three miss. */
function flood(n: number, tag: string): RawItem[] {
  return Array.from({ length: n }, (_, i) =>
    item({
      guid: `${tag}-guid-${i}`,
      url: `https://flood-${tag}.example/post-${i}`,
      title: `${tag} article ${i}`,
      // Distinct bodies, so rung 3 cannot collapse them into one row and make
      // the cap look like it fired when deduplication was what happened.
      contentHtml: `<p>Body number ${i} of the ${tag} republication, unique text.</p>`,
    }),
  );
}

async function makeFeed(): Promise<FeedTrust> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://cap-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Insert cap probe', 3, 'active')
    RETURNING id`;
  return { id: rows[0].id, guidUnstable: false, cleanPolls: 3, guidTrustOverride: "auto" };
}

async function countArticles(feedId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
  return Number(rows[0].n);
}

describe("the cap is where N7 says it is", () => {
  it("is 500 per poll", () => {
    // Pinned, because it is a product decision rather than a tuning knob: it
    // is the number of rows a single bad deploy may add to an unread count.
    expect(INSERT_CAP_PER_POLL).toBe(500);
  });

  it("starts at zero and not-hit", () => {
    const counters = emptyCounters();
    expect(counters.capHit).toBe(false);
    expect(counters.itemsCapped).toBe(0);
  });
});

/*
 * 600s. Four thousand items is the plan's number and the cap means 500 of them
 * are inserts against a remote Postgres at roughly a hundred milliseconds each
 * — about a minute of round trips that no mock would exercise. The other 3 500
 * cost almost nothing: they are refused before any statement runs.
 */
describeDb("a CMS republishing its whole archive", { timeout: 600_000 }, () => {
  const made: bigint[] = [];

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("writes at most 500 rows from 4 000 items and RAISES THE ALERT", async () => {
    const feed = await makeFeed();
    made.push(feed.id);

    const { counters } = await ingestItems(feed, flood(4_000, `big-${unique()}`));

    expect(counters.itemsSeen).toBe(4_000);
    // THE ASSERTION: the unread count gained 500, not 4 000.
    expect(counters.itemsNew).toBe(INSERT_CAP_PER_POLL);
    expect(await countArticles(feed.id)).toBe(INSERT_CAP_PER_POLL);

    // The alert. Without it the cap is a silent truncation and the operator
    // never learns a feed is misbehaving — N7 asks for both.
    expect(counters.capHit).toBe(true);
    // And HOW MANY were refused, which is what distinguishes a feed that
    // overshot by one from a CMS that republished an archive.
    expect(counters.itemsCapped).toBe(3_500);
  });

  it("does NOT fire on a poll that stays under the cap", async () => {
    // The negative case. A cap wired to fire unconditionally would pass every
    // assertion above.
    const feed = await makeFeed();
    made.push(feed.id);

    const { counters } = await ingestItems(feed, flood(20, `small-${unique()}`));

    expect(counters.itemsNew).toBe(20);
    expect(counters.capHit).toBe(false);
    expect(counters.itemsCapped).toBe(0);
  });

  it("still MERGES past the cap, so a revision in the same poll is not lost", async () => {
    /*
     * The half of N7's contract that is easy to get wrong, and this code did
     * get wrong: the loop used to `continue` past the whole item once the cap
     * was spent, so merges stopped too.
     *
     * A merge updates a row that already exists. It adds nothing to the unread
     * count the cap protects — and dropping it means an edit the reader is
     * looking at right now is silently discarded because an unrelated part of
     * the same feed flooded.
     */
    const feed = await makeFeed();
    made.push(feed.id);
    const tag = `revised-${unique()}`;

    // An article that exists before the flood, and has been read.
    const existing = item({
      guid: `${tag}-survivor`,
      url: `https://flood-${tag}.example/survivor`,
      title: `${tag} survivor`,
      contentHtml: "<p>The original body.</p>",
    });
    await ingestItems(feed, [existing]);

    // Now the flood, with the SAME article revised at the very end of it —
    // well past where the cap will have been spent.
    const revised = { ...existing, contentHtml: "<p>The body, edited after publication.</p>" };
    const { counters } = await ingestItems(feed, [...flood(600, tag), revised]);

    expect(counters.capHit).toBe(true);
    // THE ASSERTION: the merge happened even though inserts had stopped.
    expect(counters.mergedByGuid).toBe(1);
    expect(counters.revised).toBe(1);

    const row = await prisma.$queryRaw<{ content_html: string; revision_count: number }[]>`
      SELECT content_html, revision_count FROM cadence.articles
      WHERE feed_id = ${feed.id} AND title = ${`${tag} survivor`}`;
    expect(row[0].content_html).toBe("<p>The body, edited after publication.</p>");
    expect(row[0].revision_count).toBe(1);
  });

  it("counts every item exactly once across all outcomes", async () => {
    // §6.2 makes these counters the only evidence dedup works, and a capped
    // poll is where a counter is most likely to go missing: `itemsCapped` was
    // added for this, and without it the reconciliation below does not close.
    const feed = await makeFeed();
    made.push(feed.id);

    const { counters } = await ingestItems(feed, flood(520, `recon-${unique()}`));

    expect(
      counters.itemsNew +
        counters.mergedByGuid +
        counters.mergedByUrl +
        counters.mergedByContent +
        counters.droppedNoIdentity +
        counters.itemsCapped,
    ).toBe(counters.itemsSeen);
  });
});
