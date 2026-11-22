import type { FeedStatus } from "@/lib/types";

import { MAX_INTERVAL_S } from "./interval";

/*
 * What to do when a fetch fails, and when to stop trying.
 *
 * ARCHITECTURE §6.4. The part worth understanding before reading the curve is
 * that §6.4 distinguishes THREE outcomes, not two:
 *
 *   304 / soft 304   a SUCCESS. Resets `consecutive_failures`, increments
 *                    `unchanged_polls`. It is also the commonest outcome there
 *                    is, so treating it as "no new items" and widening, or
 *                    worse as a failure, poisons both the interval and the
 *                    backoff curve.
 *   200 + changes    a success that resets BOTH counters.
 *   anything else    a failure.
 *
 * Conflating the first two is what §6.4 means by the interval becoming
 * dishonest: a feed that is healthy and quiet looks identical to a feed that is
 * healthy and busy, or to one that is broken.
 *
 * Pure, like `interval.ts`, so the whole curve and the `dead` verdict are
 * testable without waiting 14 days.
 */

/** §6.4: the first retry is 5 minutes out. */
export const BACKOFF_BASE_S = 5 * 60;
/** §6.4: and it never exceeds a day. */
export const BACKOFF_CEILING_S = MAX_INTERVAL_S;
/** §6.4: 20 consecutive failures and the feed is dead. */
export const DEAD_AFTER_FAILURES = 20;
/** §6.4: or 14 days with no success at all, whichever comes first. */
export const DEAD_AFTER_SILENT_DAYS = 14;
/** ±10 % so a fleet of broken feeds does not retry in lockstep. */
export const BACKOFF_JITTER_FRACTION = 0.1;

export type FailureInput = {
  /** AFTER this failure is counted, so the first failure arrives as 1. */
  consecutiveFailures: number;
  /** `Retry-After` in seconds, when the server sent one. */
  retryAfterS: number | null;
  /** Stable per-feed jitter in [-1, 1]; derived rather than random. */
  jitterUnit?: number;
};

/**
 * How long to wait before the next attempt.
 *
 * Doubling from a 5-minute base — 5, 10, 20, 40 … — capped at a day. The
 * doubling is what keeps a broken feed from being hammered: twenty failures at
 * a fixed 5 minutes is 20 requests to a server that is already telling us to
 * stop, and the twentieth is as rude as the first.
 *
 * `Retry-After` WINS when it is longer. Honouring it is the single most
 * explicit instruction a server can give a poller, and overriding it with our
 * own curve because ours happens to be longer is fine — ignoring it because
 * ours is shorter is not.
 *
 * But it is CAPPED at the ceiling, like everything else. `Retry-After` is a
 * number from a stranger's server, and `Retry-After: 31536000` — a year, which
 * misconfigured edges do send — would otherwise schedule the feed past any
 * horizon the reader can see while the health screen still called it
 * `backoff`. A day is the longest this project waits for anything, and a
 * server that genuinely wants a year of silence will say so again tomorrow.
 */
export function backoffSeconds(input: FailureInput): number {
  const n = Math.max(1, Math.floor(input.consecutiveFailures));

  // `2 ** (n - 1)` grows past any ceiling quickly; clamped before the multiply
  // so a feed failing for a month does not compute Infinity.
  const doublings = Math.min(n - 1, 32);
  const curve = Math.min(BACKOFF_BASE_S * 2 ** doublings, BACKOFF_CEILING_S);

  const asked = input.retryAfterS === null ? null : Math.min(input.retryAfterS, BACKOFF_CEILING_S);
  const base = asked !== null ? Math.max(curve, asked) : curve;

  /*
   * ±10 %, from the caller's stable jitter rather than `Math.random()`.
   *
   * The reason is the same as the interval's: a host that returns 500 to
   * everything makes every feed on it fail in the same tick, and a
   * deterministic curve then retries them all together forever. Random would
   * spread them too, but a stable offset also survives a restart.
   */
  const unit = input.jitterUnit ?? 0;
  const jittered = base * (1 + BACKOFF_JITTER_FRACTION * Math.max(-1, Math.min(1, unit)));

  /*
   * Clamped against `Retry-After` SPECIFICALLY, not against our own curve.
   *
   * `Math.max(base, jittered)` was the first version and it threw the negative
   * half away: the spread became +0…+10 %, so every feed whose jitter was
   * negative landed on exactly 300 / 600 / 1200 s — which is half the fleet
   * retrying a broken host in lockstep, the thing the jitter exists to
   * prevent.
   *
   * What must never be shortened is a server's explicit instruction. Our own
   * doubling curve has no such claim on us, so it jitters both ways.
   */
  // `asked`, not the RAW `retryAfterS` — otherwise an uncapped year-long
  // `Retry-After` comes straight back in as the floor and defeats the cap
  // computed above. A test caught exactly that.
  return Math.round(Math.max(asked ?? 0, jittered));
}

export type VerdictInput = {
  consecutiveFailures: number;
  /**
   * When the CURRENT run of failures began — cleared on every success.
   *
   * Deliberately not `last_success_at`: that timestamp goes stale while the
   * SWEEP is down rather than while the feed is broken, and `dead` is
   * terminal. See `statusAfterFailure`.
   */
  firstFailureAt: Date | null;
  now?: Date;
};

/**
 * `active`, `backoff`, or `dead`.
 *
 * Two independent routes to `dead`, and both are needed. The failure count
 * catches a feed that is polled often and fails every time; the 14-day silence
 * catches one whose interval has widened so far that twenty failures would take
 * months — a daily feed at a 24-hour interval needs twenty days to reach twenty
 * failures, by which point the reader has been looking at a stale list for
 * three weeks.
 *
 * `not_a_feed` is NOT decided here. That is a parse verdict from §6.3, set when
 * an address answers with something that was never a feed, and it is a
 * different fact from "this feed stopped working".
 */
export function statusAfterFailure(input: VerdictInput): FeedStatus {
  const now = input.now ?? new Date();

  if (input.consecutiveFailures >= DEAD_AFTER_FAILURES) return "dead";

  // No failures means no evidence the feed is broken, whatever the clock says.
  if (input.consecutiveFailures === 0) return "active";

  /*
   * THE SILENCE IS THE LENGTH OF THE CURRENT FAILURE RUN, and nothing else.
   *
   * §6.4 says "after 20 consecutive failures, or 14 days with no success", and
   * the obvious reading — time since `last_success_at` — is wrong twice over,
   * because `dead` is TERMINAL: the claim only ever looks at `active` and
   * `backoff` feeds, so nothing revives one.
   *
   *  1. `last_success_at` goes stale while the SWEEP is not running, not while
   *     the feed is broken. A fortnight with the pinger's secret expired, or a
   *     project picked up after a holiday, and then one transient 500 kills the
   *     feed outright. The outage was ours and the feed takes the blame,
   *     permanently.
   *  2. Requiring a failure (which an earlier fix added) narrows that to "one
   *     failure after any long gap" — better, and still wrong for the same
   *     reason.
   *
   * `first_failure_at` is the start of the CURRENT run: set on the first
   * failure of a run and cleared on every success, so it measures how long the
   * feed has actually been failing. Our downtime cannot contribute to it,
   * because a sweep that is not running records no failures either.
   */
  if (input.firstFailureAt !== null) {
    const failingDays = (now.getTime() - input.firstFailureAt.getTime()) / 86_400_000;
    if (failingDays >= DEAD_AFTER_SILENT_DAYS) return "dead";
  }

  return "backoff";
}

/**
 * Everything the sweep needs to write after a failed poll.
 *
 * Returned together because the two decisions are coupled: a feed being marked
 * `dead` drops out of the `feeds_due` index, so its `next_fetch_at` stops
 * mattering — and computing one without the other is how a dead feed ends up
 * with a next-check time the health screen then displays.
 */
export function afterFailure(input: FailureInput & VerdictInput): {
  status: FeedStatus;
  nextInSeconds: number;
} {
  const status = statusAfterFailure(input);
  return {
    status,
    // A dead feed is not scheduled. The value still has to be something, and
    // the ceiling is the honest one — if it is ever revived it is not due
    // immediately.
    nextInSeconds: status === "dead" ? BACKOFF_CEILING_S : backoffSeconds(input),
  };
}
