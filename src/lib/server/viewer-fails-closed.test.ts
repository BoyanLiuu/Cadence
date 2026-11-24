import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What this suite is for: the hole review found in `getViewer()`.
 *
 * Its first version answered the fixture reader whenever `dataSource` was
 * `"fixtures"` — and an UNSET `DATABASE_URL` is enough to cause that. So a
 * deploy that lost its database, or one where the variable was never set,
 * handed every anonymous visitor a signed-in reader with every capability:
 * somebody else's subscriptions, their saved articles, and the ability to mark
 * them read.
 *
 * The reasoning that produced it was reasonable — Appendix C rule 5 says a
 * clone with no database still renders every screen — which is exactly why it
 * needs a test rather than a resolution to be careful. The rule stopped being
 * reachable the moment `clerkMiddleware()` began throwing without its keys,
 * and honouring it here was what opened the gap.
 *
 * So: the fixture reader is answered only when something SAYS SO, and the
 * absence of configuration is never that.
 */

const AUTH = vi.hoisted(() => ({ userId: null as string | null }));

const REDIRECTED = vi.hoisted(() => ({ to: null as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    REDIRECTED.to = to;
    // The real one signals by throwing, which the code under test relies on.
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: AUTH.userId }),
  // REJECTS, which is what Clerk's Backend API does for a user it no longer
  // has — a 404, not a null. The branch that handles it was unreachable for
  // this exact case until it caught the rejection too.
  currentUser: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
}));

// Imported for its side effects only; the real client would need a database.
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: {
      findUnique: () => Promise.resolve(null),
      createMany: () => Promise.resolve({ count: 0 }),
      update: () => Promise.resolve(null),
    },
  },
}));

const ENV_KEYS = ["DATABASE_URL", "CADENCE_DATA_SOURCE", "CADENCE_TEST_VIEWER"] as const;

/** Resolves `getViewer()` with a fresh module registry, so the env is read now. */
async function viewerWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { getViewer } = await import("./viewer");
  return getViewer();
}

describe("getViewer fails closed", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    AUTH.userId = null;
  });

  afterEach(() => {
    // `vitest.setup.ts` sets CADENCE_TEST_VIEWER for every other suite in the
    // project, so leaving this one's edits in place would quietly un-authorise
    // all of them.
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  it("with NO configuration at all, an anonymous visitor stays anonymous", async () => {
    // The regression, stated exactly. Before the fix this returned the fixture
    // reader — a signed-in viewer, to a visitor with no session, because a
    // variable was missing.
    expect(await viewerWith({})).toEqual({ kind: "anon" });
  });

  it("CADENCE_DATA_SOURCE=fixtures does NOT make a visitor a reader", async () => {
    /*
     * The second fail-open, found by review after the first was fixed. That
     * variable chooses which IMPLEMENTATION answers a query; nothing about it
     * says who is asking. While it opened this door, setting it — a reasonable
     * thing to do when comparing the two services — handed every anonymous
     * visitor a signed-in reader with every capability.
     */
    expect(await viewerWith({ CADENCE_DATA_SOURCE: "fixtures" })).toEqual({ kind: "anon" });
  });

  it("sends a SCREEN to /session-ended, which can clear the cookie", async () => {
    /*
     * The point of typing `StaleSession`, and it had no test: `getViewer()`
     * throws so a Route Handler can answer a status code, and `requireViewer()`
     * translates that into the one page carrying the sign-out form. Only an
     * action may write a cookie, so a page that merely reported the error would
     * leave the reader stuck for the life of the token — and `/sign-in` is the
     * bounce loop.
     */
    AUTH.userId = "user_revoked";
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.DATABASE_URL = "postgres://x";
    REDIRECTED.to = null;
    vi.resetModules();

    const { requireViewer } = await import("./viewer");
    await expect(requireViewer()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(REDIRECTED.to).toBe("/session-ended");
  });

  it("a stale session THROWS rather than reporting anon", async () => {
    /*
     * The mocked Clerk returns a user id and then refuses to describe it, which
     * is what a revoked or deleted account looks like while its short-lived
     * token is still valid.
     *
     * `anon` is the wrong answer and was the first one: it sends the reader to
     * `/sign-in`, where Clerk's still-valid session bounces them back to
     * `redirect_url`, and round it goes until the token expires — a browser
     * reports that as ERR_TOO_MANY_REDIRECTS. A message beats a loop.
     */
    AUTH.userId = "user_revoked";
    await expect(viewerWith({ DATABASE_URL: "postgres://x" })).rejects.toThrow(/stale/i);
  });
});
