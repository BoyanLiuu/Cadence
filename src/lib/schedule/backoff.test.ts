import { describe, expect, it } from "vitest";

import {
  afterFailure,
  backoffSeconds,
  statusAfterFailure,
  BACKOFF_BASE_S,
  BACKOFF_CEILING_S,
  DEAD_AFTER_FAILURES,
  DEAD_AFTER_SILENT_DAYS,
} from "./backoff";

/*
 * What this suite is for: a feed hammered while it is broken, and one abandoned
 * in silence.
 *
 * Both are failures of the same mechanism and neither reports itself. A
 * poller with no backoff keeps asking a server that is already failing, at full
 * rate, until it is blocked — and the only evidence is someone else's rate
 * limiter. A poller that backs off but never gives up retries a feed that
 * moved two years ago, forever, while the reader sees a list that quietly
 * stopped growing.
 *
 * §6.4's curve and its two routes to `dead` are both pure, so both are
 * asserted here rather than discovered in fourteen days.
 */

const NOW = new Date("2026-11-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("the doubling curve", () => {
  it("starts at five minutes", () => {
    expect(backoffSeconds({ consecutiveFailures: 1, retryAfterS: null })).toBe(BACKOFF_BASE_S);
  });

  it("doubles each failure", () => {
    const waits = [1, 2, 3, 4, 5].map((n) =>
      backoffSeconds({ consecutiveFailures: n, retryAfterS: null }),
    );
    expect(waits).toEqual([300, 600, 1200, 2400, 4800]);
  });

  it("stops at the 24-hour ceiling rather than growing forever", () => {
    // The doubling reaches a day around the ninth failure; everything after
    // must sit on the ceiling rather than computing weeks — or Infinity.
    expect(backoffSeconds({ consecutiveFailures: 15, retryAfterS: null })).toBe(BACKOFF_CEILING_S);
    expect(backoffSeconds({ consecutiveFailures: 500, retryAfterS: null })).toBe(BACKOFF_CEILING_S);
    expect(Number.isFinite(backoffSeconds({ consecutiveFailures: 1e6, retryAfterS: null }))).toBe(
      true,
    );
  });

  it("treats a first failure sanely however it is counted", () => {
    // Defensive: 0 and negative counts must not produce a zero wait, which
    // would be an immediate retry of a server that just failed.
    expect(backoffSeconds({ consecutiveFailures: 0, retryAfterS: null })).toBe(BACKOFF_BASE_S);
    expect(backoffSeconds({ consecutiveFailures: -3, retryAfterS: null })).toBe(BACKOFF_BASE_S);
  });

  it("OBEYS `Retry-After` when it is longer than the curve", () => {
    /*
     * The most explicit instruction a server can give a poller. Our curve
     * being shorter is not a reason to ignore it — that is precisely the
     * behaviour that earns a block.
     */
    expect(backoffSeconds({ consecutiveFailures: 1, retryAfterS: 3600 })).toBe(3600);
  });

  it("keeps its own curve when `Retry-After` is SHORTER", () => {
    // A server saying "try again in 1 second" after its twentieth consecutive
    // failure is not a reason to try again in 1 second.
    const n = 10;
    const curve = backoffSeconds({ consecutiveFailures: n, retryAfterS: null });
    expect(backoffSeconds({ consecutiveFailures: n, retryAfterS: 1 })).toBe(curve);
  });

  it("jitters within ±10 % of the curve", () => {
    /*
     * A host that 500s for everything fails every feed on it in the same tick,
     * and an unjittered curve then retries them all together forever.
     *
     * This assertion used to read `low >= base`, which was written to protect
     * `Retry-After` and instead encoded the one-sided bug: it made the spread
     * +0…+10 % and piled half the fleet onto the exact curve. The server's
     * instruction is protected by the two cases below; our own curve jitters
     * both ways.
     */
    const base = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: 0 });
    const low = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: -1 });
    const high = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: 1 });

    expect(low).toBeGreaterThanOrEqual(Math.round(base * 0.9));
    expect(low).toBeLessThan(base);
    expect(high).toBeGreaterThan(base);
    expect(high).toBeLessThanOrEqual(Math.round(base * 1.1));
  });

  it("jitters in BOTH directions, so half the fleet does not land on the curve", () => {
    /*
     * The first version used `Math.max(base, jittered)` to protect
     * `Retry-After`, which threw the negative half away: the spread became
     * +0…+10 %, so every feed whose jitter was negative retried at exactly
     * 300 / 600 / 1200 s. That is half the fleet hitting a broken host in
     * lockstep — the thing the jitter exists to prevent.
     */
    const curve = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: 0 });
    const low = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: -1 });
    expect(low).toBeLessThan(curve);
    expect(low).toBeGreaterThanOrEqual(Math.round(curve * 0.9));
  });

  it("still never shortens an explicit `Retry-After`, whatever the jitter", () => {
    // What must not be shortened is the SERVER's instruction. Our own curve
    // has no such claim on us.
    const asked = 3600;
    for (const jitterUnit of [-1, -0.5, 0, 0.5, 1]) {
      expect(
        backoffSeconds({ consecutiveFailures: 1, retryAfterS: asked, jitterUnit }),
      ).toBeGreaterThanOrEqual(asked);
    }
  });

  it("CAPS `Retry-After` at the ceiling", () => {
    /*
     * It is a number from a stranger's server. `Retry-After: 31536000` — a
     * year, which misconfigured edges do send — would schedule the feed past
     * any horizon the reader can see while the health screen still called it
     * `backoff`.
     */
    expect(backoffSeconds({ consecutiveFailures: 1, retryAfterS: 31_536_000 })).toBe(
      BACKOFF_CEILING_S,
    );
  });

  it("clamps an out-of-range jitter rather than trusting the caller", () => {
    const sane = backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: 1 });
    expect(backoffSeconds({ consecutiveFailures: 3, retryAfterS: null, jitterUnit: 99 })).toBe(
      sane,
    );
  });
});

describe("the dead verdict", () => {
  const healthy = { consecutiveFailures: 0, firstFailureAt: null };

  it("is active while nothing has failed", () => {
    expect(statusAfterFailure({ ...healthy, now: NOW })).toBe("active");
  });

  it("is backoff from the first failure", () => {
    expect(statusAfterFailure({ ...healthy, consecutiveFailures: 1, now: NOW })).toBe("backoff");
    expect(statusAfterFailure({ ...healthy, consecutiveFailures: 19, now: NOW })).toBe("backoff");
  });

  it("is dead at 20 consecutive failures", () => {
    expect(
      statusAfterFailure({ ...healthy, consecutiveFailures: DEAD_AFTER_FAILURES, now: NOW }),
    ).toBe("dead");
  });

  it("is ALSO dead after 14 days of FAILING, however few the failures", () => {
    /*
     * The second route, and it is not redundant. Once the interval has widened
     * to 24 hours, twenty failures take twenty days — so a feed that broke
     * three weeks ago would still read as `backoff` and the reader would have
     * been looking at a stale list the whole time.
     */
    expect(
      statusAfterFailure({
        consecutiveFailures: 3,
        firstFailureAt: daysAgo(DEAD_AFTER_SILENT_DAYS),
        now: NOW,
      }),
    ).toBe("dead");
  });

  it("is NOT dead for a feed that is merely quiet", () => {
    // A feed that answers 304 every time has no failures. Marking it dead
    // would hide a working feed.
    expect(statusAfterFailure({ consecutiveFailures: 0, firstFailureAt: null, now: NOW })).toBe(
      "active",
    );
  });

  it("does NOT kill a feed after OUR downtime plus one transient failure", () => {
    /*
     * The bug this rule had twice, and `dead` is TERMINAL — the claim only
     * looks at `active` and `backoff`, so nothing revives it.
     *
     * Measured from `last_success_at`, a fortnight with the pinger's secret
     * expired followed by one 500 kills the feed outright: our outage, the
     * feed's blame, permanently. Measured from the start of the CURRENT failure
     * run it cannot, because a sweep that is not running records no failures
     * either.
     *
     * `firstFailureAt` is today — this is the run's first failure — while the
     * last success was a month ago.
     */
    expect(
      statusAfterFailure({
        consecutiveFailures: 1,
        firstFailureAt: NOW,
        now: NOW,
      }),
    ).toBe("backoff");
  });

  it("is not dead just short of either threshold", () => {
    expect(
      statusAfterFailure({
        consecutiveFailures: DEAD_AFTER_FAILURES - 1,
        firstFailureAt: daysAgo(DEAD_AFTER_SILENT_DAYS - 1),
        now: NOW,
      }),
    ).toBe("backoff");
  });
});

describe("the two decisions together", () => {
  it("does not schedule a dead feed on the curve", () => {
    /*
     * A dead feed drops out of the `feeds_due` index, so its `next_fetch_at`
     * stops being read — but it is still displayed. Leaving it at the curve's
     * value would make the health screen promise a retry that will never
     * happen.
     */
    const out = afterFailure({
      consecutiveFailures: DEAD_AFTER_FAILURES,
      retryAfterS: null,
      firstFailureAt: daysAgo(1),
      now: NOW,
    });
    expect(out.status).toBe("dead");
    expect(out.nextInSeconds).toBe(BACKOFF_CEILING_S);
  });

  it("returns the curve for a feed that is only backing off", () => {
    const out = afterFailure({
      consecutiveFailures: 2,
      retryAfterS: null,
      firstFailureAt: daysAgo(0),
      now: NOW,
    });
    expect(out.status).toBe("backoff");
    expect(out.nextInSeconds).toBe(600);
  });
});
