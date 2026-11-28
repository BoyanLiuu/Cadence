import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, PAGE_SIZE } from "@/lib/types";

import * as service from "./article-service";
import * as mutations from "./mutations";
import { NoDatabase, NotImplementedInStaticPhase } from "./mutations";
import { assertCan, getViewer, NotAllowedError } from "./viewer";

/*
 * What this suite is for: the signature drift that makes phase 2 a rewrite.
 *
 * Appendix C's contract is that no caller changes shape when M6–M9 replace
 * these bodies with Postgres. Two properties carry that, and both are easy to
 * break by writing one convenient synchronous helper:
 *
 *   - every service function returns a promise
 *   - every one takes the viewer as its first argument
 *
 * A function that reads fixtures synchronously works perfectly in phase 1 and
 * forces every call site to change in phase 2. That is the whole cost this
 * suite exists to prevent, so it asserts the shape rather than the data.
 */

const anon = { kind: "anon" } as const;

/**
 * The module's WRITES, excluding the error classes it also exports.
 *
 * Structural rather than a list of names. The exclusion used to be
 * `v !== NotImplementedInStaticPhase`, hand-maintained — and exporting a second
 * error class (`NoDatabase`) immediately made two suites treat it as a mutation
 * and assert it "refuses an anon". A class is not a write, and asking whether
 * its prototype is an Error says so without anyone remembering to.
 */
const isWrite = (value: unknown): value is (...args: unknown[]) => Promise<unknown> =>
  typeof value === "function" && !(value.prototype instanceof Error);

describe("the service layer keeps Appendix C's contract", () => {
  // Only the FUNCTIONS are subject to the async/viewer-first rules. The module
  // also exports `dataSource`, a string naming which implementation is live.
  const reads = Object.entries(service).filter(([, v]) => typeof v === "function");
  const writes = Object.entries(mutations).filter(([, v]) => isWrite(v));

  it("reports which implementation is live rather than leaving it inferred", () => {
    // M6 made this module a chooser between fixtures and Postgres. Which one
    // is running is a fact worth being able to state — the health screen says
    // it, rather than a reader guessing from whether the numbers look real.
    expect(["db", "fixtures"]).toContain(service.dataSource);
  });

  it("exports the functions Appendix C names, plus the four it did not", () => {
    // Appendix C names three reads. Four more were added where a screen needed
    // data and the alternative was reaching past the boundary:
    //
    //   listFolders  (M1) — the sidebar needs the folder tree.
    //   listTicks    (M5) — the health page needs the tick log, and was the
    //                       first route to import `lib/fixtures` directly.
    //   countUnread  (M7) — the header's total. It was a SUM over the
    //                       sidebar's per-feed badges, which was correct only
    //                       while an article belonged to one feed. Rung 2 is
    //                       global, so a story carried by two subscribed feeds
    //                       is one article counted in both badges — and the sum
    //                       counted it twice, printing "2 unread" above a
    //                       one-row list. Distinct articles cannot be derived
    //                       from per-feed counts, so it has to be its own read.
    //   listFeedLabels (M15) — the article list's own view of the subscribed
    //                       feeds: names, status, next check. It exists because
    //                       the list pane used to wait on `listSubscriptions`,
    //                       which also derives every unread count and today's
    //                       `fetch_log` counters — measured at ~1800 ms against
    //                       ~300 ms here, on a page click that changes nothing
    //                       in the sidebar. A projection rather than a `Feed`
    //                       with zeroed counters, because §6.2 is explicit that
    //                       a count silently reading zero is worse than none.
    //
    // All four are deliberate and all four are listed here, so adding a fifth
    // is a decision rather than a drift. This assertion failing means a read
    // was added without that decision being made.
    expect(Object.keys(service).sort()).toEqual([
      "countUnread",
      "dataSource",
      "getArticle",
      "getFeedHealth",
      "listArticles",
      "listFeedLabels",
      "listFolders",
      "listSubscriptions",
      "listTicks",
    ]);
  });

  it.each(reads)("%s is async", async (_name, fn) => {
    expect(typeof fn).toBe("function");
    const result = (fn as (...a: unknown[]) => unknown)(anon, { kind: "unread" }, undefined);
    // A promise even on the failure path: a function that throws synchronously
    // for anon and returns a promise otherwise has two shapes, not one.
    expect(result).toBeInstanceOf(Promise);
    await (result as Promise<unknown>).catch(() => undefined);
  });

  it.each(reads)("%s takes the viewer first and refuses an anon", async (_name, fn) => {
    await expect(
      (fn as (...a: unknown[]) => Promise<unknown>)(anon, { kind: "unread" }, undefined),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });

  it.each(writes)("%s takes the viewer first and refuses an anon", async (_name, fn) => {
    await expect(
      (fn as (...a: unknown[]) => Promise<unknown>)(anon, 1, true),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });
});

/**
 * Writes that no longer throw, with the milestone that landed each.
 *
 * THE LIST REACHED EVERY MUTATION AT M13, so it is now history rather than a
 * mechanism. It was the shrinking half of the project: the suite asserted that
 * everything NOT named here still answered with its "nothing was sent"
 * receipt, and adding a name was the deliberate step that let a write start
 * persisting. With nothing left unimplemented there is no complement to
 * assert, and the `Set` that held these names is gone — the inverted
 * assertion above ("nothing throws the receipt") covers it, and covers it
 * better, because it cannot pass by having no cases.
 *
 * KEPT, ALL OF IT, for the warning at the bottom. That warning is why this
 * file does not call mutations to find out what they throw, and it is the
 * reason the replacement reads source instead.
 *
 *   discoverFeeds        M5 — Appendix C: "M5 pure, M12 networked"
 *   setReadState         M11 — the first durable write, PATCH /api/read-state
 *   markScopeRead        M11 — "Mark all read", resolved from a scope
 *   subscribe            M11 — POST /api/subscriptions
 *   updateSubscription   M11 — PATCH /api/subscriptions/:feedId
 *   unsubscribe          M11 — DELETE /api/subscriptions/:feedId
 *   saveArticle          M12 — the saved shelf, a server action
 *   extractArticle       M13 — on-open full text, POST /api/articles/:id/extract
 *
 * THE SUITE BELOW CALLS EVERY OTHER MUTATION WITH `(viewer, 1, true)` as a
 * viewer and junk arguments, which is safe for a function that throws
 * immediately and DESTRUCTIVE for one that does not. It has now cost real data
 * twice:
 *
 *   `markScopeRead` absent from this list meant the call arrived with `1` as a
 *   scope, which resolved to `where: undefined` and marked the seeded corpus's
 *   124 articles read.
 *
 *   `unsubscribe` absent would be worse, and argument validation does NOT save
 *   it: `1` is a perfectly well-formed feed id, and the fixture reader follows
 *   feed 1 — so the call deletes a real subscription, correctly, having been
 *   asked to. There is no shape of input check that makes "delete feed 1" safe.
 *
 * THAT HARNESS NO LONGER EXISTS, and the warning outlived it on purpose.
 * Once every mutation is implemented there is no safe version of "call it and
 * see what it throws" — nothing is left that throws before acting — so the
 * check became a source read. I wrote the dynamic version first anyway, having
 * read this paragraph while editing this file, because "just to see what it
 * throws" did not feel like calling it. A rule in a comment is not a check,
 * which this project has now found twice.
 */
/** Resolved once; these calls must not depend on a database being present. */
const VIEWER_PLACEHOLDER = await getViewer();

describe("every declared mutation is implemented", () => {
  it("leaves NOTHING throwing the phase receipt", async () => {
    /*
     * THE END OF PHASE 1'S RECEIPT MECHANISM, asserted rather than assumed.
     *
     * This block used to iterate the unimplemented mutations and check each
     * threw `NotImplementedInStaticPhase`. At M13 that set became EMPTY, and
     * an `it.each([])` proves nothing while looking like a passing suite —
     * the vacuous shape this project has caught five times. So the assertion
     * is inverted: nothing may throw the receipt.
     *
     * BY READING THE SOURCE, AND NOT BY CALLING THEM. My first version of this
     * invoked every mutation with `(viewer, 1, true)` to see what it threw,
     * which is precisely the harness the comment above spends twenty lines
     * warning about: safe for a function that throws immediately, DESTRUCTIVE
     * for one that does not. It would have called `unsubscribe(viewer, 1)` on
     * a feed the fixture reader follows and `markScopeRead(viewer, 1, true)`
     * with `1` as a scope — the two calls that have already cost real data
     * here. Now that every mutation is implemented there is no safe version of
     * that approach, because there is nothing left that throws before acting.
     *
     * The same tactic as `one-fetch-path.test.ts` and the seed guard, with the
     * same caveat: a guard that reads source must read what the compiler
     * reads. This looks for the constructor being called, so a rename fails
     * the test rather than passing wrongly.
     */
    const source = await readFile(resolve(process.cwd(), "src/lib/server/mutations.ts"), "utf8");

    // The class declaration and its doc comment mention the name; a THROW is
    // the thing being looked for.
    const throwsReceipt = [...source.matchAll(/throw new NotImplementedInStaticPhase\(/g)];

    expect(
      throwsReceipt.length,
      "a mutation still answers with the phase receipt instead of writing",
    ).toBe(0);
  });

  it("still has the receipt available for a write that is declared before it is built", () => {
    // Retired, not deleted. The shape and the argument for it are worth
    // keeping where someone adding a phase-2 mutation will find them.
    expect(new NotImplementedInStaticPhase("POST /api/x", "M99").message).toContain(
      "Nothing was sent",
    );
  });

  it("setReadState no longer answers with the phase receipt, now that M11 landed", async () => {
    /*
     * The earned half. While `IMPLEMENTED` existed, naming a mutation there
     * exempted it from the receipt assertion and proved nothing in its place —
     * so each exemption needed a case like this one. That set is gone (M13,
     * see above), and these cases stay: they assert the write is reachable,
     * which no source read can.
     *
     * BRANCHES ON THE DATA SOURCE, because 561 of this project's tests predate
     * the schema and must keep passing on a clone with no Supabase project
     * (Appendix C rule 5). The first version asserted the resolved value
     * outright and failed under `CADENCE_DATA_SOURCE=fixtures` and on any CI
     * without `DATABASE_URL` — breaking that property to test a write.
     *
     * Either way it must not be `NotImplementedInStaticPhase`: with no database
     * the honest answer is `NoDatabase`, which says the code exists and the
     * configuration does not. Behaviour is covered by `read-state.test.ts`.
     */
    const viewer = await getViewer();
    const outcome = mutations.setReadState(viewer, [], true);

    if (service.dataSource === "db") {
      await expect(outcome).resolves.toEqual({ applied: 0, ignored: 0 });
    } else {
      await expect(outcome).rejects.toBeInstanceOf(NoDatabase);
    }
  });

  it.each([
    ["subscribe", () => mutations.subscribe(VIEWER_PLACEHOLDER, { feedUrl: "not a url" })],
    ["updateSubscription", () => mutations.updateSubscription(VIEWER_PLACEHOLDER, 1.5, {})],
    ["unsubscribe", () => mutations.unsubscribe(VIEWER_PLACEHOLDER, 1.5)],
    ["saveArticle", () => mutations.saveArticle(VIEWER_PLACEHOLDER, 1.5, true)],
    ["extractArticle", () => mutations.extractArticle(VIEWER_PLACEHOLDER, 1.5)],
  ])("%s no longer answers with the phase receipt, now that M11 landed", async (_name, call) => {
    /*
     * THE EARNED EXEMPTION for the subscription writes, from when
     * `IMPLEMENTED` existed: a name added there left the receipt assertion
     * with nothing to say about it, so each needed its own case. The set is
     * gone; these remain, because "the stub is gone" is a claim about
     * behaviour and the source guard above cannot make it.
     *
     * CALLED WITH INPUT THAT CANNOT SUCCEED — an unparseable address, a
     * fractional feed id — precisely because these DO write now. `unsubscribe`
     * with a valid id would delete a real subscription, which is how the
     * generic harness cost data twice. A rejection that is not
     * `NotImplementedInStaticPhase` is the whole assertion: it proves the stub
     * is gone without asking the function to do anything.
     *
     * In fixtures mode the rejection is `NoDatabase`, which is also not the
     * phase receipt, so this holds in both modes — and `pnpm check`, which runs
     * without `CADENCE_DB_WRITE_TESTS`, covers these three for the first time.
     */
    await expect(call()).rejects.not.toBeInstanceOf(NotImplementedInStaticPhase);
  });

  it("resolves discoverFeeds rather than throwing, in either mode", async () => {
    /*
     * The exception to the rule above, and it must be an explicit exception: if
     * this function silently went back to throwing, the add-feed screen would
     * show its receipt instead of its candidates.
     *
     * THE ADDRESS IS PER MODE, so that neither branch touches the network.
     * In fixtures mode the sample map answers `found`. With a database, M12
     * made this go to the real web — and asking it for `tidewaterletters.example`
     * sent a DNS query from a unit suite on every run, which is both slow and
     * at the mercy of a resolver that answers NXDOMAIN with an address of its
     * own. A literal link-local IP is refused by `guardUrl` BEFORE any lookup,
     * so the answer is `invalid` deterministically and offline.
     *
     * The real discovery path, including what it refuses and never dials, is
     * `ingest/discover.test.ts`; the sample map's states are
     * `fixtures/discover-states.test.ts`. This asserts only that the function
     * resolves rather than throwing its phase receipt.
     */
    const viewer = await getViewer();
    const [address, kind] =
      service.dataSource === "db"
        ? ["http://169.254.169.254/", "invalid"]
        : ["tidewaterletters.example", "found"];

    const result = await mutations.discoverFeeds(viewer, address);
    expect(result.kind).toBe(kind);
  });

  it("validates discoverFeeds' input rather than crashing on it", async () => {
    // The address comes from a request body. A non-string used to throw
    // `input.trim is not a function` — a 500 where a typed rejection belongs.
    const viewer = await getViewer();
    for (const bad of [1, null, undefined, {}, []]) {
      const result = await mutations.discoverFeeds(viewer, bad as unknown as string);
      expect(result.kind).toBe("invalid");
    }
  });

  /*
   * REMOVED AT M13: "names the endpoint, so the receipt screens can say what
   * was not sent".
   *
   * It called `extractArticle` and asserted the thrown error carried
   * `endpoint: "POST /api/articles/:id/extract"`, tying the error's field to
   * the string the reading pane printed. Implementing extraction made it throw
   * `ArticleNotExtractable` instead, and there is no replacement example
   * because NO mutation throws the receipt any more.
   *
   * Its own comment had already called this: "It used `subscribe` until M11
   * implemented that, which is the hazard of picking an example from a list
   * that shrinks." The list reached zero. The property it protected — the
   * receipt carries a printable endpoint — is now on the constructor directly,
   * above, which does not depend on a stub existing to be observed.
   */
});

describe("the viewer", () => {
  it("resolves to a user with a Clerk-shaped id", async () => {
    const viewer = await getViewer();
    expect(viewer.kind).toBe("user");
    if (viewer.kind === "user") expect(viewer.user.id).toMatch(/^user_/);
  });

  it.each(CAPABILITIES)(
    "denies an anon %s, because there is no public reading surface",
    (capability) => {
      /*
       * EVERY capability, from the array rather than by hand. This named two
       * of them until `CAPABILITIES` existed to iterate, which meant the rest
       * could have been granted to visitors with nothing failing — and the
       * next one someone adds is the one most likely to be forgotten. Counting
       * them in this comment was itself wrong within a week: `merge` was cut at
       * M12 and "two of the eight" became two of the seven.
       */
      expect(() => assertCan(anon, capability)).toThrow(NotAllowedError);
    },
  );

  it.each(CAPABILITIES)("allows a signed-in reader %s", async (capability) => {
    /*
     * The mirror, and it guards a change rather than restating the rule: with
     * two actors every signed-in reader may do everything, so this passes
     * trivially today. It stops passing the day someone adds a role check here
     * — which is the moment that needs a decision rather than a quiet commit.
     */
    const viewer = await getViewer();
    expect(() => assertCan(viewer, capability)).not.toThrow();
  });
});

describe("reads are scoped and paged", () => {
  it("returns one page, and page 2 holds different rows", async () => {
    const viewer = await getViewer();
    const first = await service.listArticles(viewer, { kind: "unread" });
    expect(first.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(first.page).toBe(1);
    expect(first.pages).toBeGreaterThan(1);

    const second = await service.listArticles(viewer, { kind: "unread" }, 2);
    /*
     * THE BUG OFFSET PAGING CAN CAUSE — which is why this assertion outlived
     * the keyset cursor it was written for. A row on both pages, or one
     * between them missing, is exactly what `skip`/`take` produces the moment
     * the sort is not total: two rows sharing a `published_at` with no
     * tie-break can swap places between the two queries.
     */
    const firstIds = new Set(first.items.map((a) => a.id));
    expect(second.items.some((a) => firstIds.has(a.id))).toBe(false);
  });

  it("never returns a read article in the unread scope", async () => {
    const viewer = await getViewer();
    const page = await service.listArticles(viewer, { kind: "unread" });
    expect(page.items.every((a) => a.readAt === null)).toBe(true);
  });

  // 30s, not the default 5s. This pages through EVERY feed to compare counts,
  // which was instant against an in-memory array and is now a dozen feeds'
  // worth of round trips to a remote Postgres. The assertion is worth keeping
  // whole rather than sampling: it is the unread count, which §6.2 calls the
  // number the product's credibility rests on.
  it(
    "derives the sidebar unread count rather than reading a column",
    { timeout: 30_000 },
    async () => {
      const viewer = await getViewer();
      const subs = await service.listSubscriptions(viewer);
      expect(subs.length).toBeGreaterThan(0);

      for (const s of subs) {
        // Page all the way through rather than checking the first page, so the
        // assertion can be EQUALITY. A `>=` here would pass on any over-count,
        // which is precisely the drift the sidebar count must not have.
        let counted = 0;
        let pageNumber = 1;
        let pages = 1;
        do {
          const page = await service.listArticles(
            viewer,
            { kind: "feed", feedId: s.feedId },
            pageNumber,
          );
          counted += page.items.filter((a) => a.readAt === null).length;
          pages = page.pages;
          pageNumber += 1;
        } while (pageNumber <= pages);

        expect(s.unread).toBe(counted);
      }
    },
  );

  it("scopes folders to the reader who filed them", async () => {
    // Catches the read that is correct only while there is one fixture user:
    // folders are per-user (Appendix D), so an unscoped `return [...folders]`
    // works today and leaks another reader's filing the moment M11 lands.
    const viewer = await getViewer();
    const user = viewer.kind === "user" ? viewer.user : null;
    const got = await service.listFolders(viewer);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((f) => f.userId === user!.id)).toBe(true);
    // The corpus carries one folder belonging to another reader, so an
    // unscoped read fails here rather than passing until a second user exists.
    expect(got.some((f) => f.name === "Someone else's folder")).toBe(false);
  });

  it("returns folders in their stored order", async () => {
    const viewer = await getViewer();
    const got = await service.listFolders(viewer);
    const positions = got.map((f) => f.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("returns null for an article the reader does not subscribe to", async () => {
    const viewer = await getViewer();
    expect(await service.getArticle(viewer, 999_999)).toBeNull();
  });

  it("returns an empty log for a feed the reader does not follow", async () => {
    const viewer = await getViewer();
    expect(await service.getFeedHealth(viewer, 999_999)).toEqual([]);
  });
});
