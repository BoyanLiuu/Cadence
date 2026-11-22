import { describe, expect, it } from "vitest";

import {
  intervalSeconds,
  jitterFor,
  nextIntervalSeconds,
  JITTER_SPREAD_S,
  MIN_INTERVAL_S,
} from "./interval";

/*
 * What this suite is for: re-clustering.
 *
 * Four hundred feeds whose intervals are all multiples of 15 minutes will fire
 * on the same minute boundary. That is not a load problem for us — the sweep
 * batches — it is a politeness problem for everyone else, and more subtly it is
 * a SELF-INFLICTED one: the tick that lands on the boundary has 400 feeds due
 * at once, blows its budget, and the overflow lands on the next boundary too.
 *
 * Jitter fixes it, but only if it is STABLE. A random offset spreads load
 * identically well until the next deploy re-randomises every feed, at which
 * point they all re-cluster on whichever minute the restart happened to land
 * on — and a deploy is exactly when nobody is watching the request graph.
 *
 * ARCHITECTURE N8 states the budget this protects, and M14's scheduler
 * simulation asserts the same spread over a full simulated day. This suite is
 * the pure half: the property of the function, not of the schedule.
 */

/** A day's worth of feeds, as the simulation will have. */
const FLEET = 400;

describe("jitter survives a restart", () => {
  it("gives a feed the same offset forever", () => {
    /*
     * The whole reason this is derived rather than drawn. Two "processes" —
     * two independent calls with no shared state — must agree.
     */
    const firstBoot = Array.from({ length: FLEET }, (_, i) => jitterFor(i + 1));
    const afterRestart = Array.from({ length: FLEET }, (_, i) => jitterFor(i + 1));
    expect(afterRestart).toEqual(firstBoot);
  });

  it("gives the same offset whether the id is a bigint or a number", () => {
    // The claim returns `bigint`; tests and fixtures use `number`. If these
    // disagreed, a feed's schedule would shift depending on which path
    // computed it.
    for (const id of [1, 42, 999, 1_000_000]) {
      expect(jitterFor(BigInt(id))).toBe(jitterFor(id));
    }
  });
});

describe("the fleet does not cluster", () => {
  /** Which minute of the window each feed lands on, given one base interval. */
  function minuteHistogram(fleet: number, baseIntervalS: number): Map<number, number> {
    const counts = new Map<number, number>();
    for (let id = 1; id <= fleet; id++) {
      const at = baseIntervalS + jitterFor(id);
      const minute = Math.floor(at / 60);
      counts.set(minute, (counts.get(minute) ?? 0) + 1);
    }
    return counts;
  }

  it("spreads 400 feeds off a single minute, roughly evenly across the window", () => {
    /*
     * Without jitter every one of these 400 feeds — all on the same computed
     * interval, which is the common case because the interval is clamped and
     * most feeds hit the same clamp — lands on ONE minute: 100 %.
     *
     * NOT ASSERTED HERE: N8's "no minute receives more than 5 % of the day's
     * requests". That is a figure about a DAY, and N8 is tagged M14 for exactly
     * that reason. A ±5-minute window is about eleven minute-buckets, so 400
     * feeds on one interval average 9 % per bucket and 5 % is arithmetically
     * unreachable — a first version of this test asserted it and failed at
     * 12.75 %, which is the jitter working correctly.
     *
     * Across a real day the feeds sit at many different intervals and the
     * requests spread over 1440 minutes, which is what M14's scheduler
     * simulation measures. What this suite can prove is the property of the
     * FUNCTION: it uses its window, and near-uniformly.
     */
    const counts = minuteHistogram(FLEET, 6 * 3600);
    const worst = Math.max(...counts.values());
    const buckets = counts.size;
    const uniform = FLEET / buckets;

    // No bucket takes more than twice its even share.
    expect(worst).toBeLessThanOrEqual(uniform * 2);
    // And the single-minute pile-up is gone: without jitter this would be 400.
    expect(worst).toBeLessThan(FLEET / 5);
  });

  it("uses most of the ±5-minute window rather than a corner of it", () => {
    // A hash that only ever produced offsets in a narrow band would satisfy
    // the 5 % rule by luck on a small fleet and fail on a larger one.
    const counts = minuteHistogram(FLEET, 6 * 3600);
    // ±5 minutes is a 10-minute window, so ~11 distinct minute buckets.
    expect(counts.size).toBeGreaterThanOrEqual(9);
  });

  it("still spreads feeds added CONSECUTIVELY, which is how they arrive", () => {
    /*
     * The case a plain `id % spread` gets wrong. Feeds are added in sittings —
     * import an OPML file and ids 1…50 are consecutive — so the realistic
     * clustering risk is a run of adjacent ids, not random ones.
     */
    const counts = minuteHistogram(50, 6 * 3600);
    const worst = Math.max(...counts.values());
    expect(worst / 50).toBeLessThanOrEqual(0.2);
    expect(counts.size).toBeGreaterThanOrEqual(8);
  });

  it("spreads feeds that share the FLOOR, the most crowded interval of all", () => {
    /*
     * The floor is where crowding actually happens: every feed busier than
     * every-30-minutes is clamped to exactly 15 minutes, so they are all on one
     * interval by construction.
     */
    const counts = new Map<number, number>();
    for (let id = 1; id <= FLEET; id++) {
      const at = nextIntervalSeconds(id, {
        publishedAts: [
          new Date("2026-11-20T12:00:00Z"),
          new Date("2026-11-20T11:59:00Z"),
          new Date("2026-11-20T11:58:00Z"),
        ],
        declaredTtlS: null,
        unchangedPolls: 0,
      });
      expect(at).toBeGreaterThanOrEqual(MIN_INTERVAL_S);
      const minute = Math.floor(at / 60);
      counts.set(minute, (counts.get(minute) ?? 0) + 1);
    }
    /*
     * Note what this does NOT assert: a 5 % spread.
     *
     * `nextIntervalSeconds` floors at `MIN_INTERVAL_S`, so every feed whose
     * jitter is negative collapses onto the floor exactly — about half of them.
     * That is the correct trade: the politeness floor is a hard guarantee and
     * the spread is a best effort, and inverting that would mean polling some
     * feeds faster than 15 minutes to make a histogram look nicer.
     *
     * The spread still works in the direction it can, and M14's simulation
     * measures the real thing: requests per minute across a day, where feeds
     * sit at many different intervals rather than all at the floor.
     */
    expect(counts.size).toBeGreaterThanOrEqual(5);
  });
});

describe("jitter does not break the interval's guarantees", () => {
  it("never pushes a feed below the politeness floor", () => {
    for (let id = 1; id <= FLEET; id++) {
      const at = nextIntervalSeconds(id, {
        publishedAts: [],
        declaredTtlS: null,
        unchangedPolls: 0,
      });
      expect(at).toBeGreaterThanOrEqual(MIN_INTERVAL_S);
    }
  });

  it("stays within ±5 minutes of the computed interval", () => {
    const base = intervalSeconds({
      publishedAts: [
        new Date("2026-11-20T12:00:00Z"),
        new Date("2026-11-20T06:00:00Z"),
        new Date("2026-11-20T00:00:00Z"),
      ],
      declaredTtlS: null,
      unchangedPolls: 0,
    });
    for (let id = 1; id <= FLEET; id++) {
      const at = nextIntervalSeconds(id, {
        publishedAts: [
          new Date("2026-11-20T12:00:00Z"),
          new Date("2026-11-20T06:00:00Z"),
          new Date("2026-11-20T00:00:00Z"),
        ],
        declaredTtlS: null,
        unchangedPolls: 0,
      });
      expect(Math.abs(at - base)).toBeLessThanOrEqual(JITTER_SPREAD_S / 2);
    }
  });
});
