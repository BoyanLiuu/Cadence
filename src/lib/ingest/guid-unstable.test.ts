import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";
import { CAN_WRITE_DB } from "@/lib/db/guards";
import type { RawItem } from "@/lib/types";

import { type FeedTrust } from "./dedupe";
import { CLEAN_POLLS_FOR_TRUST, judgePoll, shouldFlagGuidUnstable } from "./guid-trust";
import { runPoll } from "./poll";

/*
 * What this suite is for: the duplicate flood from a static-site rebuild, and
 * the feed that quietly stops earning rung 1.
 *
 * §6.1's detector is three lines of arithmetic over counters `fetch_log`
 * already keeps. What makes it worth a suite is that the three polls are three
 * SEPARATE INVOCATIONS with nothing carried between them but the database — so
 * the thing under test is not the arithmetic, it is whether the state survives
 * and is read back in the right order.
 */

const describeDb = CAN_WRITE_DB ? describe : describe.skip;

let seq = 0;
const unique = () => `${Date.now()}-${seq++}`;

const TRANSPORT = { statusCode: 200, bytes: 4096 };

const item = (o: Partial<RawItem> = {}): RawItem => ({
  guid: null,
  url: null,
  title: "An article",
  author: null,
  publishedAt: "2026-11-12T09:12:00.000Z",
  contentHtml: "<p>Body text.</p>",
  summaryHtml: null,
  xmlBase: null,
  ...o,
});

async function makeFeed(cleanPolls: number): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.feeds (feed_url, url_hash, title, clean_polls, status)
    VALUES (${`https://unstable-${unique()}.example/feed`},
            decode(md5(random()::text), 'hex'), 'Instability probe', ${cleanPolls}, 'active')
    RETURNING id`;
  return rows[0].id;
}

/** The feed's learned state, re-read from the database each time. */
async function trustState(feedId: bigint): Promise<FeedTrust & { unstableSince: Date | null }> {
  const rows = await prisma.$queryRaw<
    {
      clean_polls: number;
      guid_unstable: boolean;
      guid_unstable_since: Date | null;
      guid_trust_override: "auto" | "guid" | "url";
    }[]
  >`
    SELECT clean_polls, guid_unstable, guid_unstable_since, guid_trust_override
    FROM cadence.feeds WHERE id = ${feedId}`;
  const r = rows[0];
  return {
    id: feedId,
    cleanPolls: r.clean_polls,
    guidUnstable: r.guid_unstable,
    guidTrustOverride: r.guid_trust_override,
    unstableSince: r.guid_unstable_since,
  };
}

/** Six articles at six stable addresses, with whatever guid prefix is given. */
function corpus(prefix: string, host: string): RawItem[] {
  return Array.from({ length: 6 }, (_, i) =>
    item({
      guid: `${prefix}-${i}`,
      url: `${host}/post-${i}`,
      title: `Post ${i} on ${host}`,
      contentHtml: `<p>Body of post ${i}.</p>`,
    }),
  );
}

/** A poll where `churned` of `seen` matched items disagreed on their guid. */
const poll = (seen: number, churned: number, agreed = seen - churned) => ({
  itemsSeen: seen,
  guidAgreed: agreed,
  guidChurned: churned,
});

describe("the detector itself", () => {
  it("flags three consecutive polls where the guids did not hold still", () => {
    expect(shouldFlagGuidUnstable([poll(12, 11), poll(12, 12), poll(12, 11)])).toBe(true);
  });

  it("does NOT flag on a single bad poll", () => {
    // One rebuild is not a pattern, and the flag is permanent.
    expect(shouldFlagGuidUnstable([poll(12, 12), poll(12, 0), poll(12, 0)])).toBe(false);
  });

  it("ignores polls too small to mean anything", () => {
    // §6.1 requires itemsSeen >= 5: a two-item feed where both churned is not
    // evidence of anything.
    expect(shouldFlagGuidUnstable([poll(2, 2), poll(2, 2), poll(2, 2)])).toBe(false);
  });

  it("needs three polls, not two", () => {
    expect(shouldFlagGuidUnstable([poll(12, 12), poll(12, 12)])).toBe(false);
  });

  it("does not flag a feed churning just under the threshold", () => {
    // 0.8 exactly is not "> 0.8". A feed with a few genuine republications
    // must not lose rung 1 forever.
    expect(shouldFlagGuidUnstable([poll(10, 8), poll(10, 8), poll(10, 8)])).toBe(false);
  });

  it("SKIPS unmeasured polls rather than letting them break the streak", () => {
    /*
     * "Three consecutive polls" has to mean three consecutive MEASURED ones.
     *
     * Most polls measure nothing: §6.4's conditional GET makes a 304 the
     * common case, and `recordPoll` writes a row for every attempt. Counting
     * raw rows meant one 304 between two rebuilds reset the streak — so the
     * static-site generator §6.1 is written about, polled far more often than
     * it rebuilds, would never be flagged at all.
     */
    const dead = { itemsSeen: 0, guidAgreed: 0, guidChurned: 0 };
    expect(
      shouldFlagGuidUnstable([poll(12, 12), dead, dead, poll(12, 12), dead, poll(12, 12)]),
    ).toBe(true);
  });

  it("lets a MEASURED clean poll break the streak", () => {
    // The other half: a poll that measured something and showed the ids
    // holding still IS evidence, so it must not be skipped like a 304.
    expect(shouldFlagGuidUnstable([poll(12, 12), poll(12, 0), poll(12, 12)])).toBe(false);
  });

  it("does NOT flag a feed that only ever published NEW articles", () => {
    /*
     * The bootstrap guard, as a pure test.
     *
     * Nothing matched, so no identifier was re-found and no promise was broken.
     * §6.1's literal formula divides by `items_seen`, which cannot tell this
     * apart from a feed whose every guid churned — and since every feed starts
     * untrusted, where rung 1 does not route and EVERYTHING merges at rung 2,
     * the literal reading flags every new feed on its third poll.
     */
    expect(shouldFlagGuidUnstable([poll(12, 0, 0), poll(12, 0, 0), poll(12, 0, 0)])).toBe(false);
  });
});

describe("judging one poll", () => {
  const base = {
    itemsSeen: 10,
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

  it("is UNMEASURED for a poll too small to judge", () => {
    expect(judgePoll({ ...base, itemsSeen: 4, guidAgreed: 4 })).toBe("unmeasured");
  });

  it("is UNMEASURED for a poll of nothing but NEW articles", () => {
    // Nothing matched, so no identifier was re-found and the poll says nothing
    // about stability either way. A feed's first-ever poll is this, and so is
    // every 304 once M9's conditional GET lands.
    expect(judgePoll({ ...base, itemsSeen: 10, itemsNew: 10 })).toBe("unmeasured");
  });

  it("is CLEAN when the guids agreed", () => {
    expect(judgePoll({ ...base, guidAgreed: 10 })).toBe("clean");
  });

  it("is CHURNED when they did not", () => {
    expect(judgePoll({ ...base, guidChurned: 10 })).toBe("churned");
  });

  it("needs 80% AGREEMENT to count as clean, not merely 80% non-churn", () => {
    /*
     * Hysteresis, and the gap is where a bad feed used to live.
     *
     * With one threshold for both directions, a publisher churning 79% of its
     * identifiers every poll scored clean, earned rung 1, was never flagged,
     * and the health screen told the reader "its ids have held still, so they
     * are trusted" — a lie about the one thing that screen exists to let them
     * verify.
     */
    expect(judgePoll({ ...base, guidAgreed: 8, guidChurned: 2 })).toBe("clean");
    expect(judgePoll({ ...base, guidAgreed: 21, guidChurned: 79 })).not.toBe("clean");
  });

  it("is CHURNED only past the demotion threshold, not in the band between", () => {
    // A feed in the middle is neither: it does not earn trust and does not get
    // demoted. The streak still resets, because the poll measured something and
    // failed to show stability — "three clean polls" means three in a row.
    expect(judgePoll({ ...base, guidAgreed: 1, guidChurned: 9 })).toBe("churned");
    expect(judgePoll({ ...base, guidAgreed: 3, guidChurned: 7 })).toBe("churned");
  });
});

describeDb("across polls, through the database", { timeout: 300_000 }, () => {
  const made: bigint[] = [];

  afterAll(async () => {
    if (made.length > 0) {
      await prisma.$executeRaw`DELETE FROM cadence.feeds WHERE id = ANY(${made}::bigint[])`;
    }
    await prisma.$disconnect();
  });

  it("flips guid_unstable on the third churning poll, and the FOURTH inserts 0", async () => {
    /*
     * The plan's acceptance criterion, verbatim.
     *
     * The feed starts TRUSTED (`clean_polls = 3`), which is the only state in
     * which §6.1's collapse-rate detector is the right measure: rung 1 routes,
     * so a churned guid is exactly what falls through to rung 2.
     *
     * Each poll re-publishes the same six articles with fresh guids — a
     * generator baking a build timestamp into the id.
     *
     * The feed is POPULATED first, and that poll is deliberately not one of
     * the three. A feed's first poll is all-new articles: nothing matched, so
     * no identifier was re-found and no promise was broken. Counting it would
     * mean judging a publisher on a poll that could not have shown churn.
     */
    const feedId = await makeFeed(CLEAN_POLLS_FOR_TRUST);
    made.push(feedId);
    const host = `https://rebuilt-${unique()}.example`;
    await runPoll(await trustState(feedId), corpus(`seed-${unique()}`, host), TRANSPORT);

    for (let poll = 0; poll < 3; poll++) {
      const state = await trustState(feedId);
      expect(state.guidUnstable).toBe(false);
      await runPoll(state, corpus(`build-${poll}-${unique()}`, host), TRANSPORT);
    }

    const after = await trustState(feedId);
    expect(after.guidUnstable).toBe(true);
    expect(after.unstableSince).not.toBeNull();
    // Demoted by both mechanisms, so the health screen cannot show a stale
    // score that contradicts the flag.
    expect(after.cleanPolls).toBe(0);

    // THE FOURTH POLL. Rung 1 is skipped from now on, so the churn is caught
    // by rung 2 before it can insert.
    const fourth = await runPoll(after, corpus(`build-3-${unique()}`, host), TRANSPORT);
    expect(fourth.counters.itemsNew).toBe(0);

    const total = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM cadence.articles WHERE feed_id = ${feedId}`;
    expect(Number(total[0].n)).toBe(6);
  });

  it("does NOT flag a well-behaved feed, however many times it is polled", async () => {
    // The negative case, and the one that matters most: a detector that fired
    // on everything would satisfy the assertion above. This is also the
    // regression guard for the bootstrap trap — a literal reading of §6.1's
    // formula flags this feed on its third poll.
    const feedId = await makeFeed(0);
    made.push(feedId);
    const host = `https://wellbehaved-${unique()}.example`;
    const items = corpus(`stable-${unique()}`, host);

    for (let poll = 0; poll < 4; poll++) {
      const state = await trustState(feedId);
      await runPoll(state, items, TRANSPORT);
    }

    const after = await trustState(feedId);
    expect(after.guidUnstable).toBe(false);
    // And it EARNED trust along the way, which is the other half of the point.
    expect(after.cleanPolls).toBe(CLEAN_POLLS_FOR_TRUST);
  });

  it("earns trust on three clean polls and then routes rung 1", async () => {
    const feedId = await makeFeed(0);
    made.push(feedId);
    const host = `https://earning-${unique()}.example`;
    const items = corpus(`earned-${unique()}`, host);

    // Poll 1 is all new articles: nothing matched, so nothing is judged.
    await runPoll(await trustState(feedId), items, TRANSPORT);
    expect((await trustState(feedId)).cleanPolls).toBe(0);

    // Polls 2-4 re-poll the same items unchanged, each one clean.
    for (const expected of [1, 2, 3]) {
      await runPoll(await trustState(feedId), items, TRANSPORT);
      expect((await trustState(feedId)).cleanPolls).toBe(expected);
    }

    // Now trusted, so a re-poll resolves at rung 1 rather than rung 2.
    const trusted = await runPoll(await trustState(feedId), items, TRANSPORT);
    expect(trusted.counters.mergedByGuid).toBe(6);
    expect(trusted.counters.mergedByUrl).toBe(0);
  });

  it("RESETS clean_polls on a dirty poll rather than decrementing", async () => {
    // "Three clean polls" has to mean three IN A ROW. A feed that alternates
    // clean and dirty is not a feed whose identifiers hold still, and a
    // decrementing counter would let it creep over the line.
    const feedId = await makeFeed(0);
    made.push(feedId);
    const host = `https://alternating-${unique()}.example`;
    const items = corpus(`alt-${unique()}`, host);

    await runPoll(await trustState(feedId), items, TRANSPORT);
    await runPoll(await trustState(feedId), items, TRANSPORT);
    await runPoll(await trustState(feedId), items, TRANSPORT);
    expect((await trustState(feedId)).cleanPolls).toBe(2);

    // One churning poll.
    const churned = items.map((it, i) => ({ ...it, guid: `churn-${unique()}-${i}` }));
    await runPoll(await trustState(feedId), churned, TRANSPORT);
    expect((await trustState(feedId)).cleanPolls).toBe(0);
  });

  it("leaves clean_polls alone for a poll it cannot judge", async () => {
    // A feed that posts two items a week must neither earn trust from a sample
    // of two nor be punished for it.
    const feedId = await makeFeed(2);
    made.push(feedId);
    const host = `https://tiny-${unique()}.example`;
    const items = corpus(`tiny-${unique()}`, host).slice(0, 2);

    await runPoll(await trustState(feedId), items, TRANSPORT);
    await runPoll(await trustState(feedId), items, TRANSPORT);

    expect((await trustState(feedId)).cleanPolls).toBe(2);
  });

  it("writes one fetch_log row per poll, with the counters the detector reads", async () => {
    // §6.2: `fetch_log` is the only evidence dedup works. The detector reads it
    // back, so a missing or mis-ordered row is a detector that cannot fire.
    const feedId = await makeFeed(CLEAN_POLLS_FOR_TRUST);
    made.push(feedId);
    const host = `https://logged-${unique()}.example`;
    const items = corpus(`logged-${unique()}`, host);

    await runPoll(await trustState(feedId), items, TRANSPORT);
    await runPoll(await trustState(feedId), items, TRANSPORT);

    const rows = await prisma.$queryRaw<
      { items_seen: number; items_new: number; merged_by_guid: number; status_code: number }[]
    >`
      SELECT items_seen, items_new, merged_by_guid, status_code
      FROM cadence.fetch_log WHERE feed_id = ${feedId} ORDER BY at ASC, id ASC`;

    expect(rows).toHaveLength(2);
    expect(rows[0].items_seen).toBe(6);
    expect(rows[0].items_new).toBe(6);
    expect(rows[0].status_code).toBe(200);
    // The second poll matched all six at rung 1, because the feed is trusted.
    expect(rows[1].items_new).toBe(0);
    expect(rows[1].merged_by_guid).toBe(6);
  });

  it("never clears guid_unstable once set, and never moves its timestamp", async () => {
    // §6.1 is explicit that the flag is permanent. And two overlapping ticks
    // must not each write `guid_unstable_since`.
    const feedId = await makeFeed(CLEAN_POLLS_FOR_TRUST);
    made.push(feedId);
    const host = `https://permanent-${unique()}.example`;
    await runPoll(await trustState(feedId), corpus(`seed-${unique()}`, host), TRANSPORT);

    for (let poll = 0; poll < 3; poll++) {
      await runPoll(await trustState(feedId), corpus(`p-${poll}-${unique()}`, host), TRANSPORT);
    }
    const first = await trustState(feedId);
    expect(first.guidUnstable).toBe(true);
    const since = first.unstableSince;

    // Four well-behaved polls afterwards.
    const items = corpus(`good-${unique()}`, host);
    for (let poll = 0; poll < 4; poll++) {
      await runPoll(await trustState(feedId), items, TRANSPORT);
    }

    const after = await trustState(feedId);
    expect(after.guidUnstable).toBe(true);
    expect(after.unstableSince?.getTime()).toBe(since?.getTime());
  });
});
