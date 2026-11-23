import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What this suite is for: the write path that creates a reader's `users` row.
 *
 * It had NO test, which review pointed out while finding a bug in it — the two
 * facts are related. The path only runs on a first authenticated request, so
 * nothing in the project exercised it: the fixture reader is seeded and every
 * other suite resolves to it through `CADENCE_TEST_VIEWER`. It would have run
 * for the first time in front of a real person.
 *
 * The bug was `createMany({ skipDuplicates: true })`, which is
 * `ON CONFLICT DO NOTHING` with no conflict target and therefore swallows BOTH
 * unique violations. The `email` branch written to catch a taken address was
 * unreachable, and the failure surfaced from the read-back as "vanished
 * immediately after being written" — a message describing a concurrent delete,
 * for what is really an address already held under a different Clerk id.
 *
 * Mocked rather than run against Postgres, deliberately: the cases are a
 * duplicate `id` and a duplicate `email` arriving as Prisma errors, and
 * provoking those for real means two concurrent sessions against a shared
 * database. What matters is which branch each error takes.
 */

const CLERK = vi.hoisted(() => ({
  userId: "user_new" as string | null,
  user: null as { firstName: string | null; lastName: string | null; emails: string[] } | null,
}));

const DB = vi.hoisted(() => ({
  /** Rows by id, as the database would hold them. */
  rows: new Map<
    string,
    { id: string; email: string; name: string; tz: string; aiEnabled: boolean }
  >(),
  /** Thrown by the next write, once. */
  failWith: null as { code: string; meta: { target: string[] } } | null,
  /** Whether the conflicting row lands under OUR id (an id race) or not. */
  raceWinnerAppears: false,
  creates: 0,
  updates: 0,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: CLERK.userId }),
  currentUser: () =>
    Promise.resolve(
      CLERK.user === null
        ? null
        : {
            firstName: CLERK.user.firstName,
            lastName: CLERK.user.lastName,
            primaryEmailAddress: CLERK.user.emails[0]
              ? { emailAddress: CLERK.user.emails[0] }
              : undefined,
            emailAddresses: CLERK.user.emails.map((emailAddress) => ({ emailAddress })),
          },
    ),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(DB.rows.get(where.id) ?? null),
      create: ({ data }: { data: { id: string; email: string; name: string } }) => {
        DB.creates += 1;
        if (DB.failWith !== null) {
          const error = DB.failWith;
          DB.failWith = null;
          /*
           * A LOSING RACE LEAVES THE OTHER REQUEST'S ROW BEHIND, which is the
           * whole reason the conflict happened — so the mock writes it before
           * rejecting. Without this the test pre-seeded the row itself, which
           * made `rowFor` return at its first `findUnique` and never reach the
           * write: it passed while exercising none of the path it names.
           *
           * An EMAIL conflict is the opposite — the row belongs to a different
           * id and nothing under ours appears — so `DB.raceWinnerAppears` says
           * which case this is.
           */
          if (DB.raceWinnerAppears) {
            DB.rows.set(data.id, { ...data, tz: "UTC", aiEnabled: false });
          }
          return Promise.reject(Object.assign(new Error("unique violation"), error));
        }
        DB.rows.set(data.id, { ...data, tz: "UTC", aiEnabled: false });
        return Promise.resolve(DB.rows.get(data.id));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: { email: string; name: string };
      }) => {
        DB.updates += 1;
        if (DB.failWith !== null) {
          const error = DB.failWith;
          DB.failWith = null;
          return Promise.reject(Object.assign(new Error("unique violation"), error));
        }
        const row = DB.rows.get(where.id)!;
        DB.rows.set(where.id, { ...row, ...data });
        return Promise.resolve(DB.rows.get(where.id));
      },
    },
  },
}));

/**
 * A Prisma unique violation, in BOTH shapes Prisma reports.
 *
 * One driver names the column (`["email"]`), another the constraint
 * (`users_email_key`). The distinction is load-bearing here because an id clash
 * is tolerated and an email clash is refused — and the first version of the
 * matching substring-tested `"id"`, which `users_pkey` does not contain, so a
 * race that should have been absorbed was rethrown instead.
 */
const P2002 = (target: string) => ({ code: "P2002", meta: { target: [target] } });

const ID_TARGETS = ["id", "users_pkey"];
const EMAIL_TARGETS = ["email", "users_email_key"];

async function resolveViewer() {
  vi.resetModules();
  const { getViewer } = await import("./viewer");
  return getViewer();
}

describe("the users row on a first authenticated request", () => {
  let savedTestViewer: string | undefined;

  beforeEach(() => {
    // `vitest.setup.ts` resolves every other suite to the fixture reader; this
    // one is about what happens when a REAL session is resolved.
    savedTestViewer = process.env.CADENCE_TEST_VIEWER;
    delete process.env.CADENCE_TEST_VIEWER;
    delete process.env.CADENCE_DATA_SOURCE;
    process.env.DATABASE_URL = "postgres://stub";

    DB.rows.clear();
    DB.failWith = null;
    DB.raceWinnerAppears = false;
    DB.creates = 0;
    DB.updates = 0;
    CLERK.userId = "user_new";
    CLERK.user = { firstName: "Wren", lastName: "Alder", emails: ["wren@example.com"] };
  });

  afterEach(() => {
    if (savedTestViewer === undefined) delete process.env.CADENCE_TEST_VIEWER;
    else process.env.CADENCE_TEST_VIEWER = savedTestViewer;
    vi.resetModules();
  });

  it("creates the row, because the foreign keys need it before the first subscribe", async () => {
    const viewer = await resolveViewer();

    expect(viewer).toEqual({
      kind: "user",
      user: {
        id: "user_new",
        email: "wren@example.com",
        name: "Wren Alder",
        initials: "WA",
        tz: "UTC",
        aiEnabled: false,
      },
    });
    expect(DB.creates).toBe(1);
  });

  it("does not write again once the row exists", async () => {
    // The hot path. An unconditional upsert would be a write on every request
    // of every page for the life of the account.
    DB.rows.set("user_new", {
      id: "user_new",
      email: "wren@example.com",
      name: "Wren Alder",
      tz: "UTC",
      aiEnabled: false,
    });

    await resolveViewer();
    expect(DB.creates + DB.updates).toBe(0);
  });

  it("replaces the seed's placeholder from the session", async () => {
    /*
     * The contract with `prisma/seed.ts`. The seed cannot know the name or
     * address — only Clerk does — so it writes `@placeholder.invalid` and this
     * resolves it. Before this worked, the chip said "Signed-in reader" for the
     * life of the database.
     */
    DB.rows.set("user_new", {
      id: "user_new",
      email: "user_new@placeholder.invalid",
      name: "Signed-in reader",
      tz: "UTC",
      aiEnabled: false,
    });

    const viewer = await resolveViewer();

    expect(viewer.kind === "user" && viewer.user.name).toBe("Wren Alder");
    expect(viewer.kind === "user" && viewer.user.initials).toBe("WA");
    expect(DB.updates).toBe(1);
  });

  it.each(ID_TARGETS)("TOLERATES losing a race on the id, reported as %s", async (target) => {
    /*
     * A page and its data, or two tabs, arriving together on a first request.
     * The loser of the insert must read back whichever write landed rather
     * than 500 on a duplicate key.
     */
    DB.failWith = P2002(target);
    DB.raceWinnerAppears = true;

    const viewer = await resolveViewer();

    expect(viewer.kind).toBe("user");
    // It reached the write and absorbed the conflict, rather than returning at
    // the first read.
    expect(DB.creates).toBe(1);
  });

  it.each(EMAIL_TARGETS)("REFUSES a taken email, reported as %s", async (target) => {
    /*
     * THE BUG THIS SUITE WAS WRITTEN FOR. `createMany({ skipDuplicates })`
     * swallowed this, so the branch below was unreachable and the failure came
     * out of the read-back as "vanished immediately after being written".
     *
     * It needs two Clerk identities for one address — an account deleted and
     * signed up again, or the address added to a second account. Rebinding the
     * row would hand the first account's subscriptions to the second, so it
     * refuses and names the address instead.
     */
    DB.failWith = P2002(target);

    await expect(resolveViewer()).rejects.toThrow(/already holds/i);
  });

  it("falls back to the address when Clerk has no name", async () => {
    CLERK.user = { firstName: null, lastName: null, emails: ["wren@example.com"] };

    const viewer = await resolveViewer();
    expect(viewer.kind === "user" && viewer.user.name).toBe("wren@example.com");
  });

  it("refuses a Clerk user with no address at all", async () => {
    // `users.email` is NOT NULL and UNIQUE, so a made-up placeholder would
    // collide on the second such account.
    CLERK.user = { firstName: "Wren", lastName: "Alder", emails: [] };

    await expect(resolveViewer()).rejects.toThrow(/no email address/i);
  });
});
