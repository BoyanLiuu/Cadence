import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What this suite is for: the two halves of "signed out", and the order.
 *
 * Neither is visible from the UI. A sign-out that clears the cookie looks
 * identical to one that also revoked the session — until somebody replays a
 * cookie they copied beforehand, which is the one thing this button must not
 * permit. And a cookie Clerk renames is still cleared only if the names are
 * read off the request rather than listed.
 *
 * Mocked rather than run against Clerk: the behaviour under test is which calls
 * happen and in what order, which is exactly what a mock can state and a live
 * instance cannot be asked to demonstrate.
 */

const CLERK = vi.hoisted(() => ({
  sessionId: "sess_1" as string | null,
  revoked: [] as string[],
  revokeThrows: false,
  authThrows: false,
}));

const JAR = vi.hoisted(() => ({
  cookies: [] as { name: string }[],
  deleted: [] as string[],
}));

/** The order of effects, so "revoke FIRST, then clear" is checkable. */
const ORDER = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => {
    // Clerk's own middleware throws here when its keys are missing.
    if (CLERK.authThrows) return Promise.reject(new Error("no Clerk keys"));
    return Promise.resolve({ sessionId: CLERK.sessionId });
  },
  clerkClient: () =>
    Promise.resolve({
      sessions: {
        revokeSession: (id: string) => {
          ORDER.events.push("revoke");
          if (CLERK.revokeThrows) return Promise.reject(new Error("clerk is down"));
          CLERK.revoked.push(id);
          return Promise.resolve({});
        },
      },
    }),
}));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: () => JAR.cookies,
      delete: (name: string) => {
        ORDER.events.push(`delete:${name}`);
        JAR.deleted.push(name);
      },
    }),
}));

const REDIRECTED = vi.hoisted(() => ({ to: null as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    REDIRECTED.to = to;
    // The real one signals by throwing, and the action relies on that to stop.
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const { signOut } = await import("./sign-out.action");

const run = () => signOut().catch(() => undefined);

describe("signing out", () => {
  beforeEach(() => {
    CLERK.sessionId = "sess_1";
    CLERK.revoked = [];
    CLERK.revokeThrows = false;
    CLERK.authThrows = false;
    JAR.cookies = [
      { name: "__session" },
      { name: "__client_uat" },
      { name: "__clerk_db_jwt" },
      { name: "__refresh_abc" },
      { name: "cadence_theme" },
    ];
    JAR.deleted = [];
    ORDER.events = [];
    REDIRECTED.to = null;
  });

  it("REVOKES the session, not only the cookie", async () => {
    /*
     * Clearing alone logs this browser out and leaves the session alive on
     * Clerk's side, so a cookie copied beforehand still works. That is the
     * failure a sign-out button cannot have, and it is invisible from the UI.
     */
    await run();

    expect(CLERK.revoked).toEqual(["sess_1"]);
  });

  it("revokes BEFORE clearing, so no window exists where it did neither", async () => {
    await run();

    expect(ORDER.events[0]).toBe("revoke");
  });

  it("clears Clerk's cookies by PREFIX, including ones it has not documented", async () => {
    /*
     * `__clerk_db_jwt` is the development instance's and `__refresh_abc` is
     * suffixed per instance. A hardcoded list of names stops clearing a cookie
     * the day Clerk adds or renames one, and the failure mode is a sign-out
     * that looks like it worked.
     */
    await run();

    expect(JAR.deleted.sort()).toEqual([
      "__clerk_db_jwt",
      "__client_uat",
      "__refresh_abc",
      "__session",
    ]);
  });

  it("leaves cookies that are not Clerk's alone", async () => {
    // A sign-out that wipes unrelated state is a different bug with the same
    // cause: clearing by something broader than ownership.
    await run();

    expect(JAR.deleted).not.toContain("cadence_theme");
  });

  it("still clears the cookies when revoking FAILS", async () => {
    /*
     * A Clerk outage must not trap someone signed in behind a button that
     * throws. The session outliving the click is a narrow exposure; being
     * unable to sign out at all is worse.
     */
    CLERK.revokeThrows = true;

    await run();

    expect(JAR.deleted.length).toBe(4);
    expect(REDIRECTED.to).toBe("/");
  });

  it("clears the cookies even with no session to revoke", async () => {
    // Half-signed-out is reachable: a cookie present and the session already
    // gone. The button still has to finish the job.
    CLERK.sessionId = null;

    await run();

    expect(CLERK.revoked).toEqual([]);
    expect(JAR.deleted.length).toBe(4);
  });

  it("clears the cookies even when reading the session THROWS", async () => {
    /*
     * `auth()` was outside the try, so a Clerk key or middleware failure threw
     * before a single cookie was cleared — the "trapped behind a button that
     * throws" state this action is written to rule out, reachable through the
     * one call that looked too simple to fail. Nothing caught it: moving that
     * line back out still compiles and still passes every other test here.
     */
    CLERK.authThrows = true;

    await run();

    expect(JAR.deleted.length).toBe(4);
    expect(REDIRECTED.to).toBe("/");
  });

  it("sends the reader to the one page that renders without a session", async () => {
    await run();

    expect(REDIRECTED.to).toBe("/");
  });
});
