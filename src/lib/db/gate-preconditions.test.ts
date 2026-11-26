import { describe, expect, it } from "vitest";

import { CAN_WRITE_DB } from "./guards";

/*
 * What this file is for: `pnpm gate` passing with nothing run.
 *
 * The gate runs three suites that `GATE.md` calls "a reason not to ship", and
 * one of them — `parse-twice.test.ts` — is behind `describeDb`, which becomes
 * `describe.skip` when `CAN_WRITE_DB` is false. That needs BOTH
 * `CADENCE_DB_WRITE_TESTS=1` and a reachable `DATABASE_URL`; the gate script
 * set only the first.
 *
 * So with no database configured, `pnpm gate` printed six skipped tests and
 * EXITED 0. The strongest claim in the project — one article, one row, forever
 * — reported success having asserted nothing, which is worse than no gate at
 * all because it reads as evidence.
 *
 * A skip is the right behaviour for `pnpm check`, which is deliberately
 * read-only and must pass on a clone with no Supabase project (Appendix C
 * rule 5). It is the wrong behaviour for a release gate. So the gate sets
 * `CADENCE_GATE=1` and this file turns a skip into a failure.
 */

const GATING = process.env.CADENCE_GATE === "1";

describe("the release gate's preconditions", () => {
  it.runIf(GATING)("has a database, so the gated suites actually run", () => {
    /*
     * FAILS LOUDLY rather than skipping. The message says what to do, because
     * the person who sees it is running a gate and needs the answer now.
     */
    expect(
      CAN_WRITE_DB,
      "pnpm gate needs a reachable DATABASE_URL: parse-twice.test.ts skips without one, " +
        "and a gate that skips its own assertions reports success having proved nothing",
    ).toBe(true);
  });

  /*
   * REMOVED: "does nothing outside the gate, so `pnpm check` stays
   * database-free".
   *
   * Its body was `expect(GATING || !GATING).toBe(true)` — a tautology, in the
   * one file whose entire purpose is stopping a gate from passing while
   * asserting nothing. Review found it; I wrote it.
   *
   * The property it was reaching for is real and is not testable from inside
   * this file: "`pnpm check` still passes with no database" is a claim about a
   * whole command, and the thing that actually holds it is `it.runIf(GATING)`
   * above — outside the gate there is no assertion to fail. `pnpm check`
   * running green on a clone with no `DATABASE_URL` is the evidence, and that
   * is a CI property rather than a unit test.
   */
});
