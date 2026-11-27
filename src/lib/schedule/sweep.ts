import pLimit from "p-limit";

import { fetchFeed } from "@/lib/ingest/fetch";
import { normalize } from "@/lib/ingest/normalize";
import { parse } from "@/lib/ingest/parse";
import { runPoll } from "@/lib/ingest/poll";
import { recordPoll } from "@/lib/ingest/fetch-log";
import { emptyCounters } from "@/lib/ingest/dedupe";
import type { FeedStatus } from "@/lib/types";

import {
  claimDueFeeds,
  recentPublishedAts,
  recordFailure,
  recordUnchanged,
  releaseFeed,
  storeInterval,
  storeValidators,
  CLAIM_BATCH,
  type ClaimedFeed,
} from "./claim";
import { afterFailure } from "./backoff";
import { jitterFor, medianGapSeconds, nextIntervalSeconds, JITTER_SPREAD_S } from "./interval";

/*
 * One tick of the sweep. ARCHITECTURE §6.4.
 *
 * The shape is forced by the runtime: this is a Vercel function with a hard
 * 300-second cap that can be killed at ANY moment. So it cannot be a loop
 * holding its place in memory — every bit of progress is a row, and every step
 * is safe to abandon halfway.
 *
 * Hence the two numbers. A 240-second budget inside the 300-second cap: the
 * 60-second margin is what turns "killed mid-write" into "finished early and
 * returned a summary". And a 120-second lease, so a feed claimed by a function
 * that dies anyway is back in the next couple of ticks rather than stuck.
 *
 * Extracted from the route handler on purpose. The route is auth plus a
 * response; this is the work, and it is testable without a request.
 */

/** §6.4: stop CLAIMING at 240 s, then let what is in flight settle. */
export const BUDGET_MS = 240_000;

/** §6.4: HTTP work parallel at 6. */
export const HTTP_CONCURRENCY = 6;

/**
 * One request at a time per host, however many of its feeds are due.
 *
 * The politeness rule that matters most. Six concurrent fetches spread over six
 * hosts is unremarkable; six at one host is a small burst that looks like
 * exactly what gets a poller blocked — and a reader following six feeds from
 * one publisher is ordinary.
 */
export const PER_HOST_CONCURRENCY = 1;

/**
 * How long queued work may still START after the budget is spent.
 *
 * The budget stops CLAIMING; this bounds the tail. A per-host limiter
 * serialises one publisher's feeds, so without it a reader following many feeds
 * from one site queues them behind each other and "letting in-flight work
 * settle" is what runs the function past its 300-second cap.
 *
 * 30 s of the 60 s between the budget and the cap, leaving the other half for
 * work that has genuinely started.
 */
export const SETTLE_MS = 30_000;

export type SweepOutcome = {
  claimed: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** Claimed but reached after the deadline: lease released, still due. */
  skipped: number;
  itemsNew: number;
  /** True when the budget stopped us claiming more, so work remains due. */
  budgetSpent: boolean;
  durationMs: number;
};

/** Groups the per-host limiters so they are shared across batches of one tick. */
function hostLimiter() {
  const limits = new Map<string, ReturnType<typeof pLimit>>();
  return (url: string) => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      // An unparseable URL fails in the guard a moment later. Keyed under "" so
      // it still gets a limiter rather than throwing here.
      host = "";
    }
    let limit = limits.get(host);
    if (limit === undefined) {
      limit = pLimit(PER_HOST_CONCURRENCY);
      limits.set(host, limit);
    }
    return limit;
  };
}

/**
 * Polls one claimed feed, end to end, and always releases its lease.
 *
 * Every outcome writes a `fetch_log` row, including the failures — §6.2 calls
 * that table the only evidence dedup works, and a table recording only
 * successes cannot show a feed failing. The counters are empty for a 304, which
 * is exactly right: M8's guid-trust detector then reads that poll as
 * "unmeasured" rather than as evidence either way.
 */
type PollVerdict = {
  kind: "changed" | "unchanged" | "failed" | "skipped";
  itemsNew: number;
  /** Seconds the server asked us to wait, when it said so. */
  retryAfterS: number | null;
};

async function pollOne(feed: ClaimedFeed, now: Date, deadline: number): Promise<PollVerdict> {
  /*
   * Refused before it starts, if the tick is already out of time.
   *
   * The per-host limiter serialises one publisher's feeds, so a reader
   * following 25 feeds from one site queues 25 polls behind each other. At up
   * to 25 s apiece that is far past the 300-second function cap — and
   * "let in-flight work settle" would then be the thing that gets the function
   * killed, which is precisely what the budget exists to avoid.
   *
   * So a queued poll that is reached after the deadline releases its lease and
   * reports `skipped`. The feed is still due; the next tick takes it.
   */
  if (Date.now() >= deadline) {
    await releaseFeed(feed.id, 0);
    return { kind: "skipped", itemsNew: 0, retryAfterS: null };
  }

  /*
   * The fallback, used only if something throws before a real one is computed.
   * Every normal path overwrites it — a success from the adaptive rule, a
   * failure from the backoff curve.
   */
  let nextInSeconds = feed.fetchIntervalS;
  let status: FeedStatus | undefined;
  try {
    const result = await fetchFeed(
      feed.feedUrl,
      { etag: feed.etag, lastModified: feed.lastModified, bodyHash: feed.bodyHash },
      now,
    );

    if (result.kind === "unchanged") {
      await recordUnchanged(feed.id);
      /*
       * A 304 reschedules on the adaptive rule, not on the stored constant.
       *
       * §6.4's widening lives here: `unchanged_polls` has just been
       * incremented, so once it passes the threshold the interval doubles and a
       * quiet feed is asked less often. Using the stored interval instead would
       * mean the widening never took effect on the only outcome that triggers
       * it.
       */
      const history = await recentPublishedAts(feed.id);
      nextInSeconds = nextIntervalSeconds(feed.id, {
        publishedAts: history,
        declaredTtlS: feed.declaredTtlS,
        unchangedPolls: feed.unchangedPolls + 1,
      });
      /*
       * STORED on this path too, and leaving it out was a real bug.
       *
       * The 304 branch is the ONLY place the interval actually changes — the
       * widening is driven by `unchanged_polls`, which only a 304 increments.
       * Computing the new interval and not persisting it meant
       * `fetch_interval_s` kept its old value on the one path that moves it,
       * so the health screen's "Checked every …" reported a cadence the
       * scheduler was not using.
       */
      await storeInterval(feed.id, nextInSeconds, medianGapSeconds(history));
      status = "active";
      await recordPoll(feed.id, emptyCounters(), {
        statusCode: result.status,
        durationMs: result.durationMs,
        bytes: null,
        note: result.soft ? "unchanged by body hash; server sent no validator" : null,
      });
      return { kind: "unchanged", itemsNew: 0, retryAfterS: null };
    }

    if (result.kind === "failed") {
      await recordFailure(feed.id, result.code, result.detail);
      await recordPoll(feed.id, emptyCounters(), {
        statusCode: result.status,
        durationMs: result.durationMs,
        bytes: null,
        errorCode: result.code,
        note: result.detail,
      });
      /*
       * `Retry-After` is OBEYED, not merely parsed.
       *
       * It was read out of the response and asserted in a test with no
       * consumer, which means a server answering `429, Retry-After: 3600` was
       * re-polled at the feed's normal interval — ignoring an explicit, polite
       * instruction from the publisher, which is how a poller earns a block.
       * §6.4 lists honouring it alongside the backoff curve; M10 owns the
       * curve, but this part costs one line and the alternative is rude.
       */
      /*
       * The curve and the verdict together (§6.4). `consecutiveFailures + 1`
       * because the claim read the row BEFORE `recordFailure` incremented it,
       * and the curve is a function of the count including this failure —
       * off-by-one here means every feed retries one step too fast forever.
       */
      const decided = afterFailure({
        consecutiveFailures: feed.consecutiveFailures + 1,
        retryAfterS: result.retryAfterS,
        jitterUnit: jitterFor(feed.id) / (JITTER_SPREAD_S / 2),
        firstFailureAt: feed.firstFailureAt,
        now,
      });
      nextInSeconds = decided.nextInSeconds;
      status = decided.status;
      return { kind: "failed", itemsNew: 0, retryAfterS: result.retryAfterS };
    }

    // ---- Changed. Parse, normalise, then the ladder.
    const parsed = parse(result.body, result.contentType ?? undefined);
    if (!parsed.ok) {
      await recordFailure(feed.id, parsed.reason, null);
      await recordPoll(feed.id, emptyCounters(), {
        statusCode: result.status,
        durationMs: result.durationMs,
        bytes: result.bytes,
        errorCode: parsed.reason,
      });
      // A body that will not parse is a failure like any other, and takes the
      // same curve. It is NOT `not_a_feed`: that is §6.3's verdict for an
      // address that was never a feed, which is a different fact from a feed
      // that served something broken today.
      const decided = afterFailure({
        consecutiveFailures: feed.consecutiveFailures + 1,
        retryAfterS: null,
        jitterUnit: jitterFor(feed.id) / (JITTER_SPREAD_S / 2),
        firstFailureAt: feed.firstFailureAt,
        now,
      });
      nextInSeconds = decided.nextInSeconds;
      status = decided.status;
      return { kind: "failed", itemsNew: 0, retryAfterS: null };
    }

    const { items } = normalize(parsed.items, {
      xmlBase: parsed.xmlBase,
      siteUrl: parsed.siteUrl,
      feedUrl: feed.feedUrl,
    });

    /*
     * Validators are stored BEFORE the ladder runs.
     *
     * If the process dies mid-ingest, the next poll sends the new validators,
     * gets a 304, and writes nothing — while the articles already written stay
     * written and the ones that were not are picked up whenever the feed next
     * changes. Storing them after would mean a killed ingest re-downloads and
     * re-runs the whole body, which the ladder makes harmless but which costs
     * the publisher a request we promised not to make.
     */
    await storeValidators(
      feed.id,
      { etag: result.etag, lastModified: result.lastModified, bodyHash: result.bodyHash },
      result.finalUrl,
    );

    const { counters } = await runPoll(
      feed,
      items,
      { statusCode: result.status, durationMs: result.durationMs, bytes: result.bytes },
      now,
    );
    /*
     * Rescheduled from the history INCLUDING what this poll just wrote, which
     * is why this runs after `runPoll` rather than before. A feed's first poll
     * has no articles at all, so computing the interval beforehand would give
     * every new feed the six-hour default regardless of how often it posts.
     */
    const history = await recentPublishedAts(feed.id);
    nextInSeconds = nextIntervalSeconds(feed.id, {
      publishedAts: history,
      declaredTtlS: feed.declaredTtlS,
      // Reset: a changed body is §6.4's "resets both counters".
      unchangedPolls: 0,
    });
    status = "active";
    await storeInterval(
      feed.id,
      nextInSeconds,
      medianGapSeconds(history),
      // The `<ttl>` this poll just read. Nothing persisted it before, so the
      // floor in `interval.ts` was dead code on every real feed.
      parsed.declaredTtlS,
    );

    // The counters are CARRIED BACK, not discarded. They were thrown away, so
    // every tick's summary reported `itemsNew: 0` — and that summary is the only
    // place a human sees a tick's outcome.
    return { kind: "changed", itemsNew: counters.itemsNew, retryAfterS: null };
  } finally {
    // In a `finally` so an unexpected throw still frees the feed. Otherwise one
    // bug costs that feed its lease for 120 seconds for no reason.
    await releaseFeed(feed.id, nextInSeconds, status);
  }
}

/**
 * Runs one tick: claim, poll, stop at the budget.
 *
 * Claims in BATCHES rather than all at once, so a tick with 200 due feeds works
 * through them and a tick with two does two. Stops CLAIMING at the budget and
 * then awaits what is already running — abandoning in-flight work would leave
 * exactly the half-written state the lease exists to recover, for no gain.
 */
export async function runSweep(
  options: {
    budgetMs?: number;
    batch?: number;
    now?: Date;
    /** Overrides `SETTLE_MS`. Tests use it to reach the tail in milliseconds. */
    settleMs?: number;
    /**
     * Sweeps only these feeds. Undefined sweeps everything due.
     *
     * The suites and "Fetch now" — see `claimDueFeeds`, which documents why
     * narrowing the claim is not the same as exempting a feed from it.
     */
    onlyFeedIds?: bigint[];
  } = {},
): Promise<SweepOutcome> {
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const batch = options.batch ?? CLAIM_BATCH;
  const startedAt = Date.now();

  const globalLimit = pLimit(HTTP_CONCURRENCY);
  const forHost = hostLimiter();
  /*
   * When queued work must give up rather than start.
   *
   * The budget stops CLAIMING; this stops a poll that is still sitting behind
   * a per-host limiter when the tick is nearly out of its function cap. Set
   * past the budget so in-flight work genuinely gets to settle — the margin
   * between 240 s and the 300 s cap is what that settling is for.
   */
  const deadline = startedAt + budgetMs + (options.settleMs ?? SETTLE_MS);

  const out: SweepOutcome = {
    claimed: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    itemsNew: 0,
    budgetSpent: false,
    durationMs: 0,
  };

  const inFlight: Promise<void>[] = [];

  for (;;) {
    if (Date.now() - startedAt >= budgetMs) {
      // Work is still due; the next tick picks it up. Not an error — it is the
      // design, and the summary says so.
      out.budgetSpent = true;
      break;
    }

    const now = options.now ?? new Date();
    const feeds = await claimDueFeeds(batch, options.onlyFeedIds);
    if (feeds.length === 0) break;
    out.claimed += feeds.length;

    for (const feed of feeds) {
      inFlight.push(
        /*
         * HOST LIMITER OUTSIDE, GLOBAL LIMITER INSIDE. The order is the bug.
         *
         * Nested the other way, a task takes a global slot and THEN queues on
         * its host limiter — so six feeds from one publisher occupy all six
         * global slots while five of them wait on a limiter of concurrency 1,
         * and every other host in the batch is starved behind them. One
         * publisher with six feeds stalls the whole tick.
         *
         * This way the wait happens on the host limiter, which holds nothing
         * global, and a global slot is taken only by work about to run.
         */
        forHost(feed.feedUrl)(() =>
          globalLimit(async () => {
            const verdict = await pollOne(feed, now, deadline);
            if (verdict.kind === "changed") out.changed += 1;
            else if (verdict.kind === "unchanged") out.unchanged += 1;
            else if (verdict.kind === "skipped") out.skipped += 1;
            else out.failed += 1;
            out.itemsNew += verdict.itemsNew;
          }),
        ).catch(async () => {
          /*
           * A poll that threw past `pollOne`'s own handling — its lease is
           * already released by the `finally`, so the feed is not stuck. One
           * feed must never take the tick down with it.
           */
          out.failed += 1;
        }),
      );
    }

    // Wait for this batch before claiming the next, so the budget check sees
    // real elapsed time rather than racing ahead queuing thousands of promises.
    await Promise.all(inFlight.splice(0, inFlight.length));
  }

  await Promise.all(inFlight);
  out.durationMs = Date.now() - startedAt;
  return out;
}
