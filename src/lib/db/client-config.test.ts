import { afterEach, describe, expect, it } from "vitest";

import { poolMax } from "./client";

/*
 * What this suite is for: a pool that can never hand out a connection.
 *
 * `Number(process.env.DATABASE_POOL_MAX ?? 3)` looks right and is not: an
 * empty or unparseable value is a STRING, so it survives the nullish check and
 * then coerces to 0 or NaN. `max: 0` is a pool with no connections, which
 * fails at the first query with an error that says nothing about the cause.
 */

const ORIGINAL = process.env.DATABASE_POOL_MAX;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_POOL_MAX;
  else process.env.DATABASE_POOL_MAX = ORIGINAL;
});

// The REAL function, not a copy. Importing `client.ts` is safe because the
// client itself is built lazily — see the Proxy there.

describe("the pool budget", () => {
  it.each(["", "   ", "abc", "0", "-1", "2.5", "NaN"])(
    "falls back to 3 for %o rather than producing an unusable pool",
    (value) => {
      process.env.DATABASE_POOL_MAX = value;
      expect(poolMax()).toBe(3);
    },
  );

  it("defaults to 3 when unset", () => {
    delete process.env.DATABASE_POOL_MAX;
    expect(poolMax()).toBe(3);
  });

  it("honours a real value", () => {
    process.env.DATABASE_POOL_MAX = "6";
    expect(poolMax()).toBe(6);
  });

  it("is read at call time, not captured at import", () => {
    // The whole reason this is testable: a value captured into a module
    // constant could not be changed by a test, and would also freeze whatever
    // the environment happened to be at import.
    process.env.DATABASE_POOL_MAX = "4";
    expect(poolMax()).toBe(4);
    process.env.DATABASE_POOL_MAX = "5";
    expect(poolMax()).toBe(5);
  });
});
