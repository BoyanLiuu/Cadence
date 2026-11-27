import { describe, expect, it } from "vitest";

import {
  DEFAULT_INTERVAL_S,
  JITTER_SPREAD_S,
  MAX_INTERVAL_S,
  MIN_INTERVAL_S,
  SWEEP_INTERVAL_S,
  UNCHANGED_BEFORE_WIDENING,
  effectiveIntervalSeconds,
  intervalSeconds,
  jitterFor,
  medianGapSeconds,
  nextIntervalSeconds,
} from "./interval";

/*
 * What this suite is for: an interval derived from the wrong history.
 *
 * A polling rate is the hardest thing in this project to notice being wrong.
 * Too fast and nothing fails — you simply spend someone else's bandwidth until
 * they block you, and the first symptom is a feed that stops working. Too slow
 * and the product is quietly worse than a page refresh. Neither shows up in a
 * passing test suite or an error log.
 *
 * So the whole curve is pure and asserted against synthetic histories, rather
 * than discovered in a week's time from a 429.
 */

/** `count` posts, `gapHours` apart, newest first. */
function history(count: number, gapHours: number, from = Date.parse("2026-11-20T12:00:00Z")) {
  return Array.from({ length: count }, (_, i) => new Date(from - i * gapHours * 3600_000));
}

describe("the median gap", () => {
  it("measures the gap between consecutive posts", () => {
    // Six-hourly posts → a six-hour median.
    expect(medianGapSeconds(history(10, 6))).toBe(6 * 3600);
  });

  it("is a MEDIAN, so one enormous gap does not drag it", () => {
    /*
     * The reason this is not a mean. A publisher who imports a back catalogue,
     * or whose feed carries one ancient post, produces a single gap of years —
     * and a mean would then poll a daily blog once a week.
     */
    const posts = history(9, 24);
    posts.push(new Date(Date.parse("2019-01-01T00:00:00Z")));
    const gap = medianGapSeconds(posts);
    expect(gap).toBe(24 * 3600);
  });

  it("ignores posts sharing an instant, which a bulk import produces", () => {
    const at = new Date("2026-11-20T12:00:00Z");
    // Five posts at the same second say nothing about rhythm; the two real
    // gaps around them do.
    const posts = [at, at, at, new Date(at.getTime() - 3600_000)];
    expect(medianGapSeconds(posts)).toBe(3600);
  });

  it("is null with nothing to measure", () => {
    expect(medianGapSeconds([])).toBeNull();
    expect(medianGapSeconds(history(1, 6))).toBeNull();
    // Unparseable timestamps are dropped rather than counted as 1970.
    expect(medianGapSeconds(["not a date", "also not"])).toBeNull();
  });

  it("looks only at RECENT posts", () => {
    /*
     * A blog that posted daily for years and monthly since should be polled
     * monthly. Taking the median over everything would keep it on the old
     * rhythm forever.
     */
    const recent = history(21, 24 * 30); // 21 monthly posts
    const ancient = history(200, 24, Date.parse("2019-01-01T00:00:00Z"));
    const gap = medianGapSeconds([...recent, ...ancient]);
    expect(gap).toBe(24 * 30 * 3600);
  });
});

describe("the interval", () => {
  const base = { declaredTtlS: null, unchangedPolls: 0 };

  it("is HALF the median gap, so we arrive about twice per post", () => {
    // Six-hourly posts → polled every three hours.
    expect(intervalSeconds({ ...base, publishedAts: history(10, 6) })).toBe(3 * 3600);
  });

  it("defaults to six hours with no history, not to the floor", () => {
    // A new feed is not assumed to be busy. Defaulting to 15 minutes would
    // mean every feed ever added is polled hard until it proves otherwise.
    expect(intervalSeconds({ ...base, publishedAts: [] })).toBe(DEFAULT_INTERVAL_S);
  });

  it("clamps a very busy feed to the 15-minute floor", () => {
    // Posts every 60 seconds would want a 30-second interval.
    expect(intervalSeconds({ ...base, publishedAts: history(10, 1 / 60) })).toBe(MIN_INTERVAL_S);
  });

  it("clamps a dormant feed to the 24-hour ceiling", () => {
    // Yearly posts would want a six-month interval. A publisher who returns
    // after a year should be noticed the next day, not the next half-year.
    expect(intervalSeconds({ ...base, publishedAts: history(5, 24 * 365) })).toBe(MAX_INTERVAL_S);
  });

  it("lets `<ttl>` WIDEN the interval", () => {
    // Hourly posts → a 30-minute interval, until the feed says "hourly at
    // most".
    const hourly = history(10, 1);
    expect(intervalSeconds({ ...base, publishedAts: hourly })).toBe(1800);
    expect(intervalSeconds({ ...base, publishedAts: hourly, declaredTtlS: 3600 })).toBe(3600);
  });

  it("does NOT let `<ttl>` narrow it, which is the rule most easily got backwards", () => {
    /*
     * `<ttl>60</ttl>` means "do not poll more often than hourly", not "poll
     * hourly". Read as the interval, a once-a-week feed that happens to
     * declare a ttl gets polled every hour — the publisher's own politeness
     * request turned into 168 times the traffic.
     */
    const weekly = history(10, 24 * 7);
    const without = intervalSeconds({ ...base, publishedAts: weekly });
    const withTtl = intervalSeconds({ ...base, publishedAts: weekly, declaredTtlS: 3600 });
    expect(withTtl).toBe(without);
    expect(withTtl).toBeGreaterThan(3600);
  });

  it("does not let `<ttl>` push past the ceiling either", () => {
    // A feed declaring a week must still be looked at daily.
    expect(
      intervalSeconds({ ...base, publishedAts: history(10, 6), declaredTtlS: 7 * 86400 }),
    ).toBe(MAX_INTERVAL_S);
  });

  it("WIDENS a feed that has been unchanged for a while", () => {
    const posts = history(10, 6); // → 3 h
    expect(intervalSeconds({ ...base, publishedAts: posts, unchangedPolls: 0 })).toBe(3 * 3600);
    // At the threshold, not yet.
    expect(
      intervalSeconds({ ...base, publishedAts: posts, unchangedPolls: UNCHANGED_BEFORE_WIDENING }),
    ).toBe(3 * 3600);
    // Past it, doubled.
    expect(
      intervalSeconds({
        ...base,
        publishedAts: posts,
        unchangedPolls: UNCHANGED_BEFORE_WIDENING + 1,
      }),
    ).toBe(6 * 3600);
  });

  it("does not widen past the ceiling", () => {
    expect(
      intervalSeconds({
        ...base,
        publishedAts: history(5, 24 * 365),
        unchangedPolls: 500,
      }),
    ).toBe(MAX_INTERVAL_S);
  });
});

describe("jitter", () => {
  it("is STABLE for a feed, which is the whole point", () => {
    /*
     * A random offset spreads load just as well — until the next deploy
     * re-randomises every feed and the fleet re-clusters on whichever minute
     * the restart landed on. Derived from the id, so it survives restarts.
     */
    expect(jitterFor(BigInt(42))).toBe(jitterFor(BigInt(42)));
    expect(jitterFor(BigInt(42))).toBe(jitterFor(42));
  });

  it("stays within ±5 minutes", () => {
    for (let id = 1; id <= 500; id++) {
      const j = jitterFor(id);
      expect(j).toBeGreaterThanOrEqual(-JITTER_SPREAD_S / 2);
      expect(j).toBeLessThan(JITTER_SPREAD_S / 2);
    }
  });

  it("does NOT put consecutive ids next to each other", () => {
    /*
     * A plain `id % 600` would make feeds 1…25 — which is exactly one claim
     * batch, usually added in one sitting — land on 25 consecutive seconds.
     * The hash is what breaks that up.
     */
    const consecutive = Array.from({ length: 25 }, (_, i) => jitterFor(i + 1));
    const sorted = [...consecutive].sort((a, b) => a - b);
    const spread = sorted[sorted.length - 1] - sorted[0];
    // Spread across most of the window rather than a 25-second run.
    expect(spread).toBeGreaterThan(JITTER_SPREAD_S / 2);
  });

  it("never schedules below the floor, even with a negative offset", () => {
    // The politeness guarantee has to hold for EVERY feed, not on average.
    for (let id = 1; id <= 200; id++) {
      const next = nextIntervalSeconds(id, {
        publishedAts: history(10, 1 / 60), // wants the floor
        declaredTtlS: null,
        unchangedPolls: 0,
      });
      expect(next).toBeGreaterThanOrEqual(MIN_INTERVAL_S);
    }
  });
});

describe("the cadence a reader is actually promised", () => {
  /*
   * M15: the sweep runs once a day, because Vercel's Hobby plan caps cron
   * there and fails the deployment for anything more frequent.
   *
   * A FEED CANNOT BE POLLED MORE OFTEN THAN THE TICK THAT POLLS IT, and until
   * M15 nothing in the code knew the tick's rate — the curve computed
   * intervals from 15 minutes upward and `/add` printed them, which was a
   * promise the deployment could not keep.
   */

  it("is the SWEEP's cadence for any feed that would be polled more often", () => {
    // A wire service earning the 15-minute floor is still read once a day.
    expect(effectiveIntervalSeconds(MIN_INTERVAL_S)).toBe(SWEEP_INTERVAL_S);
    expect(effectiveIntervalSeconds(4 * 60 * 60)).toBe(SWEEP_INTERVAL_S);
  });

  it("is the FEED's own interval when that is slower than the sweep", () => {
    // A dormant feed on the 24-hour ceiling is unaffected, and one beyond it
    // keeps its own number — this is a floor, not a clamp.
    expect(effectiveIntervalSeconds(MAX_INTERVAL_S)).toBe(MAX_INTERVAL_S);
    expect(effectiveIntervalSeconds(MAX_INTERVAL_S * 3)).toBe(MAX_INTERVAL_S * 3);
  });

  it("DOES NOT change what the scheduler computes, only what is shown", () => {
    /*
     * The distinction worth keeping. `nextIntervalSeconds` still produces the
     * adaptive value, `next_fetch_at` still carries it, and the sweep still
     * claims in that order — so raising the tick rate later (a Pro plan, or a
     * pinger added back) makes every per-feed interval meaningful again with
     * no change beyond `SWEEP_INTERVAL_S`.
     *
     * Had the curve itself been clamped to daily instead, that information
     * would have been destroyed at write time and could not be recovered.
     */
    const frequent = nextIntervalSeconds(1, {
      publishedAts: Array.from({ length: 20 }, (_, i) =>
        new Date(Date.UTC(2026, 10, 20, 0, i * 5)).toISOString(),
      ),
      declaredTtlS: null,
      unchangedPolls: 0,
    });

    expect(frequent).toBeLessThan(SWEEP_INTERVAL_S);
    expect(effectiveIntervalSeconds(frequent)).toBe(SWEEP_INTERVAL_S);
  });
});
