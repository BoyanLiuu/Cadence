import { describe, expect, it } from "vitest";

import { MAX_INTERVAL_S, MIN_INTERVAL_S, JITTER_SPREAD_S, nextIntervalSeconds } from "./interval";
import { BUDGET_MS, HTTP_CONCURRENCY, PER_HOST_CONCURRENCY } from "./sweep";

/*
 * What this suite is for: a scheduler that is polite in theory (M14, N8).
 *
 * §6.4's numbers have been design intent for the whole project. Nothing has
 * measured them, because measuring them needs a fleet and a day — so this
 * simulates both: 400 synthetic feeds with varied posting rates, stepped
 * through a virtual 24 hours, with the REAL interval function deciding when
 * each one comes due.
 *
 * PURE, AND THAT IS WHAT MAKES IT POSSIBLE. `runSweep` is coupled to Postgres
 * — it claims leases and writes `fetch_log` — so simulating a day through it
 * would need 400 rows and 1 440 ticks against a remote database. The DECISIONS
 * are all in `interval.ts`, which is pure by design and says so: "everything
 * here is a function of values the caller already has, which is what lets the
 * whole curve be tested against synthetic histories instead of waiting a week
 * to find out it is wrong." This is that test.
 *
 * WRITTEN TO MEASURE, NOT TO PASS. M14's whole job is that these numbers are
 * either demonstrated or RECORDED AS MISSED, so where a bound does not hold the
 * assertion states the measured value and the comment says what it means.
 */

/** §6.4's budget per tick, and N8's ceiling. */
const BUDGET_S = BUDGET_MS / 1000;
const DAY_S = 24 * 60 * 60;
const FLEET = 400;

/**
 * One synthetic feed, with a posting rhythm and therefore an interval.
 *
 * VARIED ON PURPOSE, and the mix matters more than the count: a fleet of 400
 * identical feeds would poll in lockstep whatever the scheduler did, so it
 * would measure the fixture rather than the code. These are the shapes a real
 * subscription list has.
 */
type Feed = { id: number; gapS: number; host: string };

function fleet(): Feed[] {
  const feeds: Feed[] = [];
  for (let i = 0; i < FLEET; i += 1) {
    /*
     * Four rhythms: a wire service posting every few minutes, a news site
     * hourly, a blog weekly, and a dormant feed that has not posted in months.
     * The last is the one that lands on `MAX_INTERVAL_S`, where the fleet is
     * most likely to cluster.
     */
    const gapS = [5 * 60, 60 * 60, 7 * DAY_S, 120 * DAY_S][i % 4]!;
    /*
     * Hosts repeat, because they do in life: a reader with 400 feeds has
     * several from Substack, several from WordPress.com and several from one
     * news group. That repetition is the whole reason `PER_HOST_CONCURRENCY`
     * exists, and a fixture of 400 distinct hosts would never exercise it.
     */
    const host = `host-${i % 40}.example`;
    feeds.push({ id: 1000 + i, gapS, host });
  }
  return feeds;
}

/** The interval this feed would actually be given, from the real function. */
function intervalFor(feed: Feed, now: number): number {
  // A synthetic history at this feed's rhythm, which is what `publishedAts`
  // means — the median gap is what the curve is computed from.
  const publishedAts = Array.from({ length: 20 }, (_, k) =>
    new Date(now - (k + 1) * feed.gapS * 1000).toISOString(),
  );
  return nextIntervalSeconds(feed.id, { publishedAts, declaredTtlS: null, unchangedPolls: 0 });
}

/**
 * Steps a virtual day and records the minute each poll lands in.
 *
 * `startAllTogether` is the case worth being honest about: an OPML import or a
 * fresh seed gives every feed the same `next_fetch_at`, which is the worst
 * realistic input for load spreading.
 */
function simulateDay(feeds: Feed[], startAllTogether: boolean) {
  const perMinute = new Array<number>(1440).fill(0);
  const pollsByFeed = new Map<number, number[]>();

  for (const feed of feeds) {
    const interval = intervalFor(feed, 0);
    // Staggered start spreads the FIRST poll across the day, which is what a
    // list grown one feed at a time looks like.
    let at = startAllTogether ? 0 : (feed.id * 7919) % DAY_S;
    const polls: number[] = [];

    while (at < DAY_S) {
      perMinute[Math.floor(at / 60)]! += 1;
      polls.push(at);
      at += interval;
    }
    pollsByFeed.set(feed.id, polls);
  }

  const total = perMinute.reduce((sum, n) => sum + n, 0);
  const busiest = Math.max(...perMinute);

  return { perMinute, pollsByFeed, total, busiest, share: busiest / total };
}

describe("the scheduler, over a simulated day", () => {
  const feeds = fleet();

  it("gives every feed an interval inside §6.4's floor and ceiling", () => {
    /*
     * The bound the other assertions rest on. A single feed outside it — a
     * negative interval from a feed whose history is all in the future, say —
     * would poll continuously and make every load measurement meaningless.
     */
    for (const feed of feeds) {
      const interval = intervalFor(feed, 0);
      expect(interval, `feed ${feed.id} (gap ${feed.gapS}s)`).toBeGreaterThanOrEqual(
        MIN_INTERVAL_S,
      );
      /*
       * `JITTER_SPREAD_S / 2`, which is what `jitterFor` actually guarantees:
       * it returns `(hash % SPREAD) - SPREAD / 2`, so ±300 s, not ±600 s. The
       * looser bound left room for a regression that un-centred the jitter to
       * push dormant feeds past §6.4's ceiling and still pass.
       */
      expect(interval, `feed ${feed.id}`).toBeLessThanOrEqual(MAX_INTERVAL_S + JITTER_SPREAD_S / 2);
    }
  });

  /*
   * REMOVED: "polls every feed within ±20 % of its own interval".
   *
   * IT COULD NOT FAIL. `simulateDay` advances a feed by one constant interval
   * — `at += interval` — so every gap it produced equalled the interval it was
   * then compared against, and the deviation was exactly zero by construction.
   * It was arithmetic checking itself, dressed as N8's second number.
   *
   * The real property needs something this simulation does not model. "Polled
   * within ±20 % of its interval" is a claim about the SWEEP delivering on the
   * schedule: a feed comes due, and whether it is actually polled then depends
   * on the claim batch, the 240 s budget and how much else is due. A feed can
   * be late only because the tick ran out of budget, and nothing here models
   * budget. Asserting it over due-times alone cannot be anything but vacuous.
   *
   * So it is gone rather than weakened, and what jitter determinism this
   * suite needed is covered where it belongs — `interval.test.ts` already
   * pins that a feed's offset is stable. `GATE.md` states the rule this
   * follows: a test that cannot fail is worse than no test, because it reads
   * as coverage.
   */

  it("keeps the busiest minute under 5 % of the day, for a list grown over time", () => {
    /*
     * N8's load bound, on the ordinary case: a subscription list built one feed
     * at a time, so first polls are already spread.
     */
    const { share, busiest, total } = simulateDay(feeds, false);

    expect(
      share,
      `busiest minute carried ${busiest} of ${total} polls (${(share * 100).toFixed(1)} %)`,
    ).toBeLessThanOrEqual(0.05);
  });

  it("holds the 5 % bound even on a bulk import — but NOT because of jitter", () => {
    /*
     * THE HONEST ONE, and the measurement changed what I thought it would say.
     *
     * An OPML import or `pnpm db:seed` gives every feed the same
     * `next_fetch_at` — `addSubscription` sets it to `now()` — so all 400 come
     * due in the same minute. Jitter does NOT spread that: `jitterFor` offsets
     * the INTERVAL, not the initial due time, so it only begins separating
     * feeds from their second poll onward. Nothing in §6.4 claims otherwise;
     * it is simply a thing the design does not do, and it is easy to assume it
     * does.
     *
     * The bound still holds, at ~2.9 %, and the reason is worth knowing
     * because it is not the one the jitter suggests: the 400 wire-service polls
     * through the rest of the day make the denominator large. What protects the
     * PUBLISHERS in that first minute is elsewhere entirely —
     * `HTTP_CONCURRENCY` at 6 and `PER_HOST_CONCURRENCY` at 1, which turn 400
     * due feeds into at most six requests in flight and never two at one host.
     *
     * So this case asserts the bound AND pins the mechanism, because a future
     * change that removed the concurrency limiter would still pass a
     * distribution test.
     */
    const bulk = simulateDay(feeds, true);
    const grown = simulateDay(feeds, false);

    expect(
      bulk.share,
      `bulk import: busiest minute carried ${bulk.busiest} of ${bulk.total} polls`,
    ).toBeLessThanOrEqual(0.05);

    /*
     * THE SPIKE IS REAL AND MUCH LARGER THAN THE AVERAGE, which the share alone
     * hides. Stated as a ratio so the number means something: a bulk import's
     * first minute is this many times the busiest minute of the same fleet
     * grown over time.
     */
    const spike = bulk.busiest / grown.busiest;
    expect(spike).toBeGreaterThan(10);

    // Every feed is due at once, so the first minute is the whole fleet. If
    // this ever drops, something has started spreading first polls and the
    // reasoning above needs revisiting rather than the number.
    expect(bulk.perMinute[0]).toBe(FLEET);
  });

  it("does NOT jitter a feed's FIRST poll, which is what a bulk import needs", () => {
    /*
     * Pinned as a fact rather than reported as a bug, because for a reader
     * adding ONE feed immediate is right: you paste an address and want
     * articles, not a wait of up to five minutes. The bulk case that would
     * want the opposite — OPML import — is not built, so engineering for it now
     * would be speculative.
     *
     * This exists so the next person reading `jitterFor`'s comment about the
     * fleet re-clustering does not conclude that first polls are spread. They
     * are not, and `addSubscription` setting `next_fetch_at = now()` is where
     * that is decided.
     */
    const first = feeds
      .slice(0, 50)
      .map((feed) => simulateDay([feed], true).pollsByFeed.get(feed.id)![0]);
    expect(new Set(first)).toEqual(new Set([0]));
  });

  it("SPREADS feeds that share an interval, which is the only thing jitter does", () => {
    /*
     * ADDED BECAUSE THE REST OF THIS SUITE DID NOT NEED JITTER TO PASS.
     *
     * I replaced `jitterFor` with `return 0` to check the simulation
     * discriminated, and all seven cases still passed — because the fleet's
     * staggered start spreads first polls across the day, and that stagger
     * dominated every distribution measurement. The suite was measuring my
     * fixture, not the scheduler.
     *
     * This is the case jitter actually exists for: feeds that come due
     * TOGETHER and share a RHYTHM. Without jitter their intervals are
     * identical, so they poll in lockstep forever — one minute carrying the
     * whole cohort, every cohort-interval, for as long as the feeds live. With
     * it, each feed's offset is derived from its id and they separate.
     *
     * `jitterFor`'s own comment explains why the offset is stable rather than
     * random: a random one spreads load equally well until a deploy
     * re-randomises it and the fleet re-clusters on whichever minute the
     * restart landed on.
     */
    const cohort = Array.from({ length: 100 }, (_, i) => ({
      id: 5000 + i,
      gapS: 60 * 60,
      host: "one.example",
    }));

    const { perMinute, total } = simulateDay(cohort, true);

    /*
     * MEASURED AFTER THE FIRST MINUTE, and that exclusion is the point rather
     * than a convenience. Minute 0 carries the whole cohort by definition —
     * they all came due together and jitter does not touch a first poll, which
     * is the fact the case above pins. Jitter's effect is on every poll AFTER
     * that, so including minute 0 made this assertion fail with jitter working
     * perfectly, which is what it did on the first run.
     */
    const afterFirst = perMinute.slice(1);
    const busiest = Math.max(...afterFirst);

    // Without jitter all 100 land on one minute every hour, forever: `busiest`
    // is 100 and one minute in sixty carries the lot.
    expect(busiest, "a cohort sharing an interval is polling in lockstep").toBeLessThan(
      cohort.length,
    );
    expect(busiest / total).toBeLessThanOrEqual(0.05);
  });

  it("never asks one host for two things at once, by construction", () => {
    /*
     * N8's concurrency number. The limiter lives in `sweep.ts` and is keyed by
     * host, so what can be checked without a database is that the FIXTURE
     * actually exercises it — several feeds sharing a host — and that the
     * constants are what §6.4 says.
     *
     * The live behaviour is `sweep.ts`'s own suite, which runs a real tick
     * against a loopback server. Stated rather than implied, because a
     * simulation asserting its own constants would be measuring nothing.
     */
    const byHost = new Map<string, number>();
    for (const feed of feeds) byHost.set(feed.host, (byHost.get(feed.host) ?? 0) + 1);

    expect(Math.max(...byHost.values())).toBeGreaterThan(1);
    expect(PER_HOST_CONCURRENCY).toBe(1);
    expect(HTTP_CONCURRENCY).toBeGreaterThan(PER_HOST_CONCURRENCY);
  });

  it("fits a tick's claimed work inside the budget at measured per-poll cost", () => {
    /*
     * N8's first number: no tick over 240 s. The sweep claims in batches and
     * stops claiming when the budget is spent, so what this checks is the
     * arithmetic that makes the budget reachable — that the fleet's busiest
     * minute is work a single tick can actually finish.
     *
     * 1.5 s per poll is the figure to argue with: a conditional GET returning
     * 304 is a round trip and nothing else, and the corpus measures well under
     * that. If real ticks come in slower, this number is where the simulation
     * stops matching and the budget needs revisiting rather than this test.
     */
    const PER_POLL_S = 1.5;
    const { busiest } = simulateDay(feeds, false);
    const wallClockS = (busiest * PER_POLL_S) / HTTP_CONCURRENCY;

    expect(wallClockS, `${busiest} polls at ${PER_POLL_S}s / ${HTTP_CONCURRENCY}-way`).toBeLessThan(
      BUDGET_S,
    );
  });
});
