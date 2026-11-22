import { ingestItems, type FeedTrust, type LadderCounters } from "./dedupe";
import { recordPoll, type PollTransport } from "./fetch-log";
import { recordTrust, type TrustOutcome } from "./guid-trust";
import { resurfaceAll, type Resurfaced } from "./revise";
import type { RawItem } from "@/lib/types";

/*
 * One poll's worth of writes, in the one order that works.
 *
 * `ingestItems` resolves and writes the articles; three things then have to
 * happen, and each depends on the one before:
 *
 *   1. INGEST          the ladder, which produces the counters
 *   2. RESURFACE       read state for the articles this poll revised. Before
 *                      the log, because a resurface can fail and a `fetch_log`
 *                      row claiming a clean poll would then be wrong
 *   3. RECORD THE POLL `fetch_log`, which is the history step 4 reads
 *   4. RECORD TRUST    `clean_polls`, and `guid_unstable` from the last three
 *                      rows — INCLUDING the one just written
 *
 * Step 4 after step 3 is the subtle one. The detector asks "have the last three
 * polls all collapsed by address?", and the poll that just finished is one of
 * those three. Running trust first would judge a feed on its previous three
 * polls and let the newest evidence wait a tick — so a feed would be demoted
 * one poll later than §6.1 says, and the test asserting "the fourth poll
 * inserts 0" would be asserting the fifth.
 *
 * M9 owns the sweep that calls this: the lease, the conditional GET, the budget
 * and the concurrency limits. This function is deliberately ignorant of all of
 * it — it takes items that have already been fetched and normalised, so it can
 * be tested without a network.
 */

export type PollOutcome = {
  counters: LadderCounters;
  trust: TrustOutcome;
  resurfaced: Resurfaced[];
  fetchLogId: bigint;
};

/** A poll that fetched and parsed items. */
export async function runPoll(
  feed: FeedTrust,
  items: RawItem[],
  transport: PollTransport,
  now: Date = new Date(),
): Promise<PollOutcome> {
  const { counters, resolutions } = await ingestItems(feed, items, now);

  const resurfaced = await resurfaceAll(
    resolutions.filter((r) => r.revised).map((r) => r.articleId),
  );

  const fetchLogId = await recordPoll(feed.id, counters, transport);
  const trust = await recordTrust(feed.id, counters);

  return { counters, trust, resurfaced, fetchLogId };
}
