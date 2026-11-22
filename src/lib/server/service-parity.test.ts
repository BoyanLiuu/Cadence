import { describe, expect, it } from "vitest";

import type { FetchLogEntry, Scope } from "@/lib/types";

import { CAN_READ_DB } from "@/lib/db/guards";

import * as db from "./article-service.db";
import * as fixtures from "./article-service.fixtures";
import { getViewer } from "./viewer";

/*
 * What this suite is for: the seam.
 *
 * Appendix C's phase-2 check, stated exactly: "swap the service implementation
 * back to fixtures and the UI must be identical." That is the whole claim M1
 * was built to make true — every signature written before a database existed,
 * every function async from the start, the viewer argument there from day one
 * — and this is the only place the claim is actually tested.
 *
 * The comparison is deep-equal on the RESULTS, not on the queries, because
 * what matters is that no component can tell which implementation answered.
 * A difference here is a bug in one of the two, not a difference in the input:
 * `prisma/seed.ts` writes the same fixture corpus through the real schema, so
 * both are answering the same questions about the same articles.
 *
 * SKIPPED, not failed, with no database configured. 561 of the tests in this
 * project predate the schema and must keep running on a clone with no Supabase
 * project.
 */

// Read-only, so a configured database is enough.
const HAS_DB = CAN_READ_DB;
const describeDb = HAS_DB ? describe : describe.skip;

const SCOPES: Scope[] = [
  { kind: "unread" },
  { kind: "all" },
  { kind: "saved" },
  { kind: "feed", feedId: 1 },
  { kind: "feed", feedId: 1, unreadOnly: true },
  { kind: "feed", feedId: 4 },
  { kind: "folder", folderId: 2 },
  { kind: "folder", folderId: 2, unreadOnly: true },
];

describeDb("the two implementations answer identically", () => {
  it("listFolders", async () => {
    const viewer = await getViewer();
    expect(await db.listFolders(viewer)).toEqual(await fixtures.listFolders(viewer));
  });

  it("listSubscriptions, including the derived unread counts", async () => {
    // The sharpest comparison available: the unread count is derived two
    // completely different ways — a filter over an array, and a pair of
    // grouped aggregates minus each other — and they must agree exactly.
    const viewer = await getViewer();
    const fromDb = await db.listSubscriptions(viewer);
    const fromFixtures = await fixtures.listSubscriptions(viewer);

    expect(fromDb.map((s) => s.feedId)).toEqual(fromFixtures.map((s) => s.feedId));
    expect(fromDb.map((s) => s.unread)).toEqual(fromFixtures.map((s) => s.unread));
  });

  it("listSubscriptions' today counters agree, field by field", async () => {
    /*
     * The sharpest comparison in this suite, and writing it found that the
     * database path reported **0 for every counter on every feed** — for five
     * milestones, because an all-empty health table is a believable state
     * rather than an obviously broken one.
     *
     * The cause was that `today` is derived from `fetch_log` rows dated
     * `>= start of UTC day`, while every fixture log entry carries a frozen
     * date from the corpus's own `NOW`. The seed now reconstructs each feed's
     * designed day inside the current UTC day, so both sides report the same
     * figures — see `prisma/seed.ts` for why reconstructing beat shifting every
     * fixture date.
     *
     * Compared field by field rather than with one deep-equal so a failure
     * names the counter that diverged. This block GROWS — M8 added
     * `guidAgreed`/`guidChurned`, which had to reach the type, the query,
     * twelve fixtures and the seed — and missing any one of those shows
     * different numbers depending on which implementation answered, on the one
     * screen Appendix E says exists to let a reader verify rather than trust.
     */
    const viewer = await getViewer();
    const fromDb = await db.listSubscriptions(viewer);
    const fromFixtures = await fixtures.listSubscriptions(viewer);

    expect(fromDb.length).toBe(fromFixtures.length);
    expect(fromDb.length, "database has no subscriptions; run pnpm db:seed").toBeGreaterThan(0);

    /*
     * PRECONDITION, named rather than assumed.
     *
     * `today` is the only figure in this suite read off state the seed cannot
     * freeze: it is an aggregate over rows dated `>= start of UTC day`, so a
     * database seeded yesterday reports zero for all of it, and a sweep that
     * has run since the seed reports more than the corpus describes. Both
     * produce a wall of numeric diffs that say nothing about which
     * implementation is wrong — so each is caught here and named instead.
     */
    const expectedChecks = fromFixtures.reduce((n, row) => n + row.feed.today.checks, 0);
    const actualChecks = fromDb.reduce((n, row) => n + row.feed.today.checks, 0);
    expect(expectedChecks, "the corpus describes no checks today").toBeGreaterThan(0);
    expect(
      actualChecks,
      "every today counter is zero: the database was seeded on an earlier UTC " +
        "day (today's counters are rebased at seed time). Run pnpm db:seed",
    ).toBeGreaterThan(0);
    expect(
      actualChecks,
      "more checks today than the corpus describes: a sweep has run since the " +
        "seed, so fetch_log no longer holds only seeded rows. Run pnpm db:seed",
    ).toBeLessThanOrEqual(expectedChecks);

    const byId = new Map(fromFixtures.map((row) => [row.feedId, row]));
    for (const row of fromDb) {
      const expected = byId.get(row.feedId);
      expect(expected, `feed ${row.feedId} missing from fixtures`).toBeDefined();
      for (const key of Object.keys(row.feed.today) as (keyof typeof row.feed.today)[]) {
        expect(row.feed.today[key], `feed ${row.feedId} (${row.feed.title}) · today.${key}`).toBe(
          expected!.feed.today[key],
        );
      }
    }
  });

  it("the fixture log tail is still the NEWEST thing in fetch_log", async () => {
    /*
     * The counters above are an aggregate over the day; `log` is the newest
     * handful of rows, and the two are seeded from the same table. Making the
     * counters right by writing rows dated inside today is therefore a way to
     * make `log` WRONG — synthetic rows stamped later than the fixture tail
     * push the designed history off the end of a `take 8`, and the health
     * screen shows eight identical 200s where the corpus describes a rhythm of
     * 304s and occasional fetches. That is what this asserts against.
     *
     * The comparison is a PREFIX and skips `at`, both deliberately. The corpus
     * authors `log` as a partial tail of a bigger day — feed 1 shows 8 checks
     * of 39 — so a feed can legitimately have older rows the fixtures do not
     * carry, and the seed rebases dates onto the current clock so the frozen
     * `at` values cannot match by construction. What must hold is that the
     * designed entries come first, in order, unchanged.
     */
    const viewer = await getViewer();
    const fromDb = await db.listSubscriptions(viewer);
    const byId = new Map(
      (await fixtures.listSubscriptions(viewer)).map((row) => [row.feedId, row]),
    );

    let entriesCompared = 0;
    for (const row of fromDb) {
      const expected = byId.get(row.feedId)!.feed.log;
      const got = row.feed.log;
      const shared = Math.min(expected.length, got.length);
      expect(shared, `feed ${row.feedId} (${row.feed.title}) has no log entries`).toBeGreaterThan(
        0,
      );

      for (let i = 0; i < shared; i += 1) {
        /*
         * Field by field, skipping `at`, so a failure names the field that
         * diverged rather than printing two whole entries to be diffed by eye.
         *
         * The keys come from BOTH sides. `note` is optional and conditionally
         * spread, so iterating the fixture's keys alone would never look at a
         * `note` only the database carries — which is the shape of divergence
         * this suite exists to catch, silently passing.
         */
        const keys = new Set<keyof FetchLogEntry>([
          ...(Object.keys(expected[i]) as (keyof FetchLogEntry)[]),
          ...(Object.keys(got[i]) as (keyof FetchLogEntry)[]),
        ]);
        for (const key of keys) {
          if (key === "at") continue;
          const where = `feed ${row.feedId} (${row.feed.title}) · log[${i}].${key}`;
          expect(got[i][key], where).toBe(expected[i][key]);
        }
        entriesCompared += 1;
      }

      // Newest first, which `take 8` depends on meaning anything.
      for (let i = 1; i < got.length; i += 1) {
        expect(
          got[i].at <= got[i - 1].at,
          `feed ${row.feedId} (${row.feed.title}) · log[${i}] is newer than log[${i - 1}]`,
        ).toBe(true);
      }
    }

    // A guard on the guard: `shared` going to zero everywhere would make the
    // loop above vacuous while still passing. Counted in ENTRIES, so the floor
    // is one per feed and the number means what the message says.
    expect(entriesCompared, "fewer log entries compared than feeds").toBeGreaterThan(fromDb.length);
  });

  it.each(SCOPES.map((s) => [JSON.stringify(s), s] as const))(
    "countUnread for %s agrees",
    async (_label, scope) => {
      /*
       * Two genuinely different derivations of the number §6.1 says the
       * product's credibility rests on: an array filter and a `count` over an
       * `EXISTS` on arrivals.
       *
       * Added because changing the database's semantics WITHOUT changing the
       * fixtures' is exactly what this suite caught once already — the
       * sidebar's badge said 9 from fixtures and 12 from Postgres for the same
       * feed, because only one of them had moved to per-arrival counting.
       */
      const viewer = await getViewer();
      expect(await db.countUnread(viewer, scope)).toBe(await fixtures.countUnread(viewer, scope));
    },
  );

  it("countUnread is NOT the sum of the per-feed badges", async () => {
    /*
     * The distinction the function exists for, asserted on real data.
     *
     * A story carried by two subscribed feeds counts in BOTH badges —
     * correctly, since both feeds carry it — so the sum exceeds the number of
     * distinct unread articles. The header used to be that sum, and printed
     * "2 unread" above a list holding one row.
     *
     * The fixture corpus has two syndicated articles, so the gap is real
     * rather than hypothetical. If it ever becomes zero this assertion is
     * telling you the corpus lost its only cross-feed case, and the bug it
     * guards became untested.
     */
    const viewer = await getViewer();
    const subs = await db.listSubscriptions(viewer);
    const summed = subs.reduce((n, s) => n + s.unread, 0);
    const distinct = await db.countUnread(viewer, { kind: "unread" });

    expect(distinct).toBeLessThan(summed);
  });

  it.each(SCOPES.map((s) => [JSON.stringify(s), s] as const))(
    "listArticles for %s returns the same rows in the same order",
    async (_label, scope) => {
      const viewer = await getViewer();
      const fromDb = await db.listArticles(viewer, scope);
      const fromFixtures = await fixtures.listArticles(viewer, scope);

      expect(fromDb.items.map((a) => a.id)).toEqual(fromFixtures.items.map((a) => a.id));
      expect(fromDb.next).toEqual(fromFixtures.next);
    },
  );

  it("paginates identically, page for page", async () => {
    // Where a keyset implementation most easily diverges: the tie-break on
    // `(publishedAt, id)` has to be written twice, once in JS and once in SQL.
    const viewer = await getViewer();
    const scope: Scope = { kind: "all" };

    let dbCursor = (await db.listArticles(viewer, scope)).next ?? undefined;
    let fxCursor = (await fixtures.listArticles(viewer, scope)).next ?? undefined;
    expect(dbCursor).toEqual(fxCursor);

    for (let page = 0; page < 3 && dbCursor; page += 1) {
      const fromDb = await db.listArticles(viewer, scope, dbCursor);
      const fromFixtures = await fixtures.listArticles(viewer, scope, fxCursor);
      expect(fromDb.items.map((a) => a.id)).toEqual(fromFixtures.items.map((a) => a.id));
      dbCursor = fromDb.next ?? undefined;
      fxCursor = fromFixtures.next ?? undefined;
      expect(dbCursor).toEqual(fxCursor);
    }
  });

  it("filters by title identically", async () => {
    const viewer = await getViewer();
    for (const query of ["council", "LATHE", "ferry", "zzz-no-match"]) {
      const fromDb = await db.listArticles(viewer, { kind: "all" }, undefined, { query });
      const fromFixtures = await fixtures.listArticles(viewer, { kind: "all" }, undefined, {
        query,
      });
      expect(
        fromDb.items.map((a) => a.id),
        `query ${query}`,
      ).toEqual(fromFixtures.items.map((a) => a.id));
    }
  });

  it("getArticle agrees on the fields a screen renders", async () => {
    const viewer = await getViewer();
    for (const id of [101, 116, 118, 123, 124, 999_999]) {
      const fromDb = await db.getArticle(viewer, id);
      const fromFixtures = await fixtures.getArticle(viewer, id);

      if (fromFixtures === null) {
        expect(fromDb, `article ${id}`).toBeNull();
        continue;
      }
      expect(fromDb, `article ${id}`).not.toBeNull();
      // Compared field by field rather than wholesale: `body`, `revision` and
      // `arrivals` are richer in the fixtures than ingestion can yet produce,
      // and pretending otherwise would be a test that lies in our favour.
      expect(fromDb!.id).toBe(fromFixtures.id);
      expect(fromDb!.title).toBe(fromFixtures.title);
      expect(fromDb!.feedId).toBe(fromFixtures.feedId);
      expect(fromDb!.publishedAt).toBe(fromFixtures.publishedAt);
      expect(fromDb!.readAt).toBe(fromFixtures.readAt);
      expect(fromDb!.savedAt).toBe(fromFixtures.savedAt);
      expect(fromDb!.extractStatus).toBe(fromFixtures.extractStatus);
      expect(fromDb!.revisedAt).toBe(fromFixtures.revisedAt);
    }
  });

  it("refuses an anon in both, before touching any data", async () => {
    const anon = { kind: "anon" } as const;
    await expect(db.listSubscriptions(anon)).rejects.toThrow();
    await expect(fixtures.listSubscriptions(anon)).rejects.toThrow();
  });

  it("scopes folders to their owner in both", async () => {
    // The corpus carries one folder belonging to another reader, so an
    // unscoped read leaks it. Both implementations must refuse.
    const viewer = await getViewer();
    for (const impl of [db, fixtures]) {
      const got = await impl.listFolders(viewer);
      expect(got.some((f) => f.name === "Someone else's folder")).toBe(false);
    }
  });
});

describe("the chooser", () => {
  it("defaults to fixtures with no DATABASE_URL, so a clone still runs", async () => {
    // Appendix C rule 5: the fixture corpus is the test corpus. A clone with
    // no Supabase project must still render every screen and pass every test
    // that predates the schema.
    //
    // An explicit `CADENCE_DATA_SOURCE` wins, which is the documented way to
    // force the comparison — so it is honoured here rather than ignored, which
    // is what made the first version of this assertion fail under the very
    // workflow the chooser documents.
    const forced = process.env.CADENCE_DATA_SOURCE;
    const { dataSource } = await import("./article-service");
    if (forced === "fixtures" || forced === "db") {
      expect(dataSource).toBe(forced);
    } else {
      expect(dataSource).toBe(HAS_DB ? "db" : "fixtures");
    }
  });
});
