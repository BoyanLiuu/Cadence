/*
 * How often to check each feed, derived from the feed's own behaviour.
 *
 * ARCHITECTURE §6.4. Fixed polling is what gets a reader blocked: a daily
 * newsletter checked every 15 minutes is 96 pointless requests a day, and a
 * busy news feed checked hourly is a reader who finds out late. So the interval
 * comes from the feed — the median gap between its recent posts, halved, so we
 * arrive roughly twice per post rather than once.
 *
 * Pure. Everything here is a function of values the caller already has, which
 * is what lets the whole curve be tested against synthetic histories instead of
 * waiting a week to find out it is wrong.
 */

/** §6.4's floor. See the note on why it is not lower. */
export const MIN_INTERVAL_S = 15 * 60;
/** §6.4's ceiling. Even a dormant feed gets looked at daily. */
export const MAX_INTERVAL_S = 24 * 60 * 60;
/** With no history to measure, assume six hours rather than the floor. */
export const DEFAULT_INTERVAL_S = 6 * 60 * 60;
/** How many posts the median is taken over (§6.4). */
export const HISTORY_WINDOW = 20;
/** Unchanged polls before the interval starts widening. */
export const UNCHANGED_BEFORE_WIDENING = 10;
/** Total jitter spread: ±5 minutes. */
export const JITTER_SPREAD_S = 600;

/**
 * Why the floor is 15 minutes and not lower.
 *
 * Feedly calibrates it: its free tier polls between 30 minutes and a day, and
 * its *paid top tier* as often as every 7 minutes. A personal reader at 15
 * minutes is therefore already more aggressive than most of what people pay
 * for — so going lower buys nothing a reader would notice and spends goodwill
 * we need to keep. Recorded as a constant with a reason because "why not 5
 * minutes?" is the obvious question and the answer is not technical.
 */
export const FLOOR_RATIONALE =
  "Feedly's paid top tier polls every 7 minutes and its free tier every 30 " +
  "minutes to a day. 15 minutes for a personal reader is already more " +
  "aggressive than most paid tiers.";

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The median of a list, or null when there is nothing to take one of. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median gap between consecutive posts, in seconds.
 *
 * MEDIAN rather than mean, and that is the whole reason this is not an average:
 * one back-dated import, or a publisher posting a year's archive in a morning,
 * produces a single enormous or tiny gap that drags a mean somewhere useless.
 * A median shrugs at both.
 *
 * Sorted newest-first and clipped to the window before measuring, because a
 * feed's recent rhythm is the question — a blog that posted daily in 2019 and
 * monthly since should be polled monthly.
 */
export function medianGapSeconds(publishedAts: (string | Date)[]): number | null {
  const times = publishedAts
    .map((at) => (at instanceof Date ? at.getTime() : Date.parse(at)))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)
    .slice(0, HISTORY_WINDOW);

  if (times.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const gap = (times[i] - times[i + 1]) / 1000;
    // Two posts at the same instant — a bulk import — say nothing about rhythm.
    if (gap > 0) gaps.push(gap);
  }
  return median(gaps);
}

/**
 * Jitter in seconds, STABLE for a given feed.
 *
 * Stability is the point. A random offset per poll would spread load just as
 * well, but every deploy re-randomises it and the fleet re-clusters on
 * whichever minute the restart landed on. Derived from the feed id, so a feed's
 * offset is the same forever and the spread survives a restart.
 */
export function jitterFor(feedId: bigint | number): number {
  // FNV-1a over the decimal id. A plain modulo of the id itself would make
  // consecutive ids adjacent, which is exactly the clustering being avoided.
  let hash = 0x811c9dc5;
  for (const ch of String(feedId)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % JITTER_SPREAD_S) - JITTER_SPREAD_S / 2;
}

export type IntervalInput = {
  /** `published_at` of the feed's recent articles, any order. */
  publishedAts: (string | Date)[];
  /** The feed's `<ttl>` in seconds, if it declared one. */
  declaredTtlS: number | null;
  /** Consecutive polls that changed nothing (§6.4). */
  unchangedPolls: number;
};

/**
 * The interval, before jitter.
 *
 * Four steps, in this order, and each exists because of a specific failure:
 *
 *  1. HALF THE MEDIAN GAP, so we arrive about twice per post. No history means
 *     six hours — a new feed is not assumed to be busy.
 *  2. CLAMPED to 15 minutes … 24 hours. The floor is politeness
 *     (`FLOOR_RATIONALE`); the ceiling means even a dormant feed is looked at
 *     daily, so a publisher who returns after a year is noticed.
 *  3. `<ttl>` RAISES IT, NEVER LOWERS IT. This is the rule most easily got
 *     backwards: `<ttl>60</ttl>` means "do not poll more often than hourly",
 *     not "poll hourly". Treating it as the interval would make us poll a
 *     once-a-week feed every hour because it happened to declare a ttl.
 *  4. WIDENED when the feed has been unchanged for a while, doubling up to the
 *     ceiling. A feed that has not moved in ten polls is probably not about to.
 */
export function intervalSeconds(input: IntervalInput): number {
  const gap = medianGapSeconds(input.publishedAts);
  let interval = gap === null ? DEFAULT_INTERVAL_S : gap / 2;

  interval = clamp(interval, MIN_INTERVAL_S, MAX_INTERVAL_S);

  // A floor, so `Math.max`. Clamped to the ceiling as well: a feed declaring
  // `<ttl>` of a week must not push `next_fetch_at` a week out.
  if (input.declaredTtlS !== null && input.declaredTtlS > 0) {
    interval = Math.min(Math.max(interval, input.declaredTtlS), MAX_INTERVAL_S);
  }

  if (input.unchangedPolls > UNCHANGED_BEFORE_WIDENING) {
    interval = Math.min(interval * 2, MAX_INTERVAL_S);
  }

  return Math.round(interval);
}

/**
 * Seconds until this feed should next be polled, jitter included.
 *
 * Never below the floor even after a negative jitter, so the politeness
 * guarantee holds for every feed rather than on average.
 */
export function nextIntervalSeconds(feedId: bigint | number, input: IntervalInput): number {
  const base = intervalSeconds(input);
  return Math.max(MIN_INTERVAL_S, base + jitterFor(feedId));
}
