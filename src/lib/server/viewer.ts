import { cache } from "react";

import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";

import { CURRENT_PATH_HEADER } from "@/lib/http/current-path";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db/client";
import { sampleUser } from "@/lib/fixtures";
import type { Capability, User, Viewer } from "@/lib/types";

import { isPlaceholderEmail } from "./placeholder-user";

/*
 * Who is acting, and what they may do.
 *
 * ARCHITECTURE §3: the acting user comes from the session, NEVER from a request
 * argument. No service function takes a user id; they take a `Viewer` that only
 * this module produces. That rule was cheap to keep from M1 and is why nothing
 * downstream changed when the fixture reader became a real one here.
 */

/**
 * The only way to resolve a session to the fixture reader instead.
 *
 * PURPOSE-NAMED AND OPT-IN, never inferred. Every DB-backed suite calls
 * `getViewer()` and none of them has a Clerk request to read, so without this
 * they would all resolve to `anon` and be refused — and the shortcut everyone
 * reaches for under that pressure is `NODE_ENV !== "production"`, which is
 * ambient, true in staging, and one misconfigured deploy away from serving the
 * fixture reader's data to the public. `CRON_SECRET` is held to the same rule
 * and for the same reason.
 *
 * Set in `vitest.setup.ts`. Production never sets it, so production fails
 * closed to the real session.
 */
const TEST_VIEWER = "CADENCE_TEST_VIEWER";

/**
 * Initials for the account chip, from the display name.
 *
 * Derived rather than stored: `users` has no `initials` column, and Appendix B
 * is deliberate about the row holding only what Clerk is the source of truth
 * for. Two letters at most, because the chip is a fixed-width square.
 *
 * Exported for its own test — the cases that matter are a single name, a name
 * with three parts, and an email with no name at all, and none of them is
 * reachable through `getViewer()` without a Clerk session to fake.
 */
export function initialsFor(name: string, email: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  if (words.length >= 2) {
    // First and LAST, not first and second: "Maria del Carmen Ruiz" reads as
    // MR rather than MD.
    return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  }
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  // No name set in Clerk, which is normal for an email-link sign-up.
  return (email.trim()[0] ?? "?").toUpperCase();
}

/** A `users` row as the domain type, with the chip's initials derived. */
const toUser = (row: {
  id: string;
  email: string;
  name: string;
  tz: string;
  aiEnabled: boolean;
}): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  initials: initialsFor(row.name, row.email),
  tz: row.tz,
  aiEnabled: row.aiEnabled,
});

/**
 * The `users` row for a Clerk id, created on first sight.
 *
 * WHY THE ROW HAS TO EXIST BEFORE ANYTHING ELSE: `subscriptions` and
 * `user_articles` both carry a foreign key to it, so a signed-in account
 * without one fails on its FIRST SUBSCRIBE — a foreign-key error on a button
 * press, long after sign-in looked like it worked, and nothing on that screen
 * could explain it.
 *
 * READ FIRST, WRITE ONLY IF MISSING OR UNRESOLVED. An unconditional upsert
 * would mean a write on every request of every page for the life of the
 * account, and the row changes approximately never. It also keeps Clerk's
 * Backend API out of the hot path: `currentUser()` is a network call, made only
 * when there is nothing usable in the row yet.
 *
 * `isPlaceholderEmail` is the contract with `prisma/seed.ts`. The seed creates
 * a row so a real account has something to read, but it cannot know the name
 * or address — only Clerk does, and writing them into a seed would put a
 * personal address in a public repository. So it writes the marker and this
 * replaces it on first authenticated sight. Without that, the row keeps saying
 * "Signed-in reader" forever and the account chip shows the wrong initials for
 * the life of the database.
 *
 * REQUIRES A DATABASE. There is no fixtures path here: a reader resolved from a
 * real Clerk session has to be a real row, because that row is what
 * `subscriptions` and `user_articles` point at. With no `DATABASE_URL` the
 * client's own error says so by name — which is the honest failure for "signed
 * in, nowhere to store it" and is why `getViewer()`'s fixtures door is a
 * TEST-ONLY switch rather than a fallback.
 */
async function rowFor(userId: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (existing !== null && !isPlaceholderEmail(existing.email)) {
    return toUser(existing);
  }

  /*
   * `currentUser()` REJECTS rather than answering null when Clerk no longer has
   * the user — a 404 from the Backend API — so the branch below was unreachable
   * for the very case it documents until this catch existed. Both shapes are
   * handled because only one of them is documented anywhere.
   */
  const clerkUser = await currentUser().catch(() => null);
  if (clerkUser === null) {
    /*
     * The session names a user Clerk will not describe — revoked or deleted
     * between `auth()` and here.
     *
     * THROWS RATHER THAN REPORTING `anon`, which is what it did first and which
     * review caught as the same redirect loop the `email` case below is written
     * to avoid: `anon` sends the reader to `/sign-in`, Clerk still holds a valid
     * short-lived token and bounces them to `redirect_url`, and round it goes
     * until the token expires. A browser shows that as ERR_TOO_MANY_REDIRECTS,
     * which is worse than a message.
     *
     * The right answer is to END the stale session rather than report it, so
     * when sign-out lands this should redirect there instead — it is the one
     * action that breaks the loop by clearing the cookie.
     */
    throw new Error(
      `Clerk session names user ${userId}, which Clerk will not describe. The ` +
        `session is stale; signing out and in again clears it.`,
    );
  }

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
  if (email === undefined) {
    // `users.email` is NOT NULL and UNIQUE. A placeholder would collide on the
    // second such account and is worse than refusing.
    throw new Error(`Clerk user ${userId} has no email address; cannot create a users row`);
  }

  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || email;

  /*
   * WRITE, THEN READ BACK, and tolerate losing a race on `id` while refusing
   * to lose one on `email`. The two conflicts are different problems:
   *
   *   `id`    the same account racing itself — a page and its data, or two
   *           tabs. The loser must not 500, so the insert skips duplicates and
   *           the read-back returns whichever write landed.
   *   `email` a DIFFERENT Clerk id already holds this address. Rebinding the
   *           existing row would hand that account's subscriptions to whoever
   *           signed up second, and leaving it unresolved would send a
   *           signed-in reader to `/sign-in` forever (Clerk sees a valid
   *           session and bounces them straight back). So it throws.
   *
   * The email case is reachable without a production instance — Cadence stays
   * on Clerk's development one — but it needs two Clerk identities for one
   * address: deleting an account and signing up again, or adding the same
   * address to a second account. Rare, and the wrong answer to it is silent.
   */
  try {
    if (existing === null) {
      /*
       * `create`, NOT `createMany({ skipDuplicates })`. That is
       * `ON CONFLICT DO NOTHING` with no conflict target, so it swallows BOTH
       * unique violations — review found it made the `email` branch below
       * unreachable on this path, and the read-back then failed with "vanished
       * immediately after being written", a message describing a concurrent
       * delete for what is really a taken address — the one thing it is not.
       *
       * `create` throws on either conflict and the catch tells them apart.
       */
      await prisma.user.create({ data: { id: userId, email, name } });
    } else {
      // The seed's placeholder, now resolvable. `update` and not `upsert`: the
      // row demonstrably exists.
      await prisma.user.update({ where: { id: userId }, data: { email, name } });
    }
  } catch (error) {
    if (uniqueViolationOn(error) === "email") {
      throw new Error(
        `Clerk user ${userId} has address ${email}, which another users row ` +
          `already holds. Reassign or remove that row — resolving it here ` +
          `would move one account's subscriptions to another.`,
        { cause: error },
      );
    }
    // Any other unique conflict is the same account racing itself on `id` — a
    // page and its data, or two tabs. The loser reads back whichever write
    // landed.
    if (uniqueViolationOn(error) === null) throw error;
  }

  const row = await prisma.user.findUnique({ where: { id: userId } });
  if (row === null) {
    // Written and then not found: a concurrent delete, and guessing is worse
    // than saying so.
    throw new Error(`users row for Clerk user ${userId} vanished immediately after being written`);
  }
  return toUser(row);
}

/**
 * Which unique constraint a Prisma P2002 is about.
 *
 * `users` has exactly two: the primary key on `id` and a unique on `email`. So
 * the question is only ever "is this the address?", and anything else is the id.
 * That matters because the two are handled OPPOSITELY — an id clash is a race
 * to tolerate, an email clash is a refusal — and Prisma does not report the
 * target consistently: `["email"]` on one driver, a constraint NAME like
 * `users_pkey` or `users_email_key` on another. Asking "does it mention email"
 * and treating everything else as the id is correct under all of those, where
 * substring-matching `"id"` was not: `users_pkey` contains no `id`, so a
 * tolerated race was being rethrown.
 */
function uniqueViolationOn(error: unknown): "email" | "other" | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, meta } = error as { code?: unknown; meta?: { target?: unknown } };
  if (code !== "P2002") return null;
  const target = meta?.target;
  const mentions = (value: unknown) => String(value).toLowerCase().includes("email");
  if (Array.isArray(target) ? target.some(mentions) : mentions(target)) return "email";
  return "other";
}

/**
 * Resolves the session to a user, once per request.
 *
 * `cache()` is what makes "once per request" true: six screens call this and
 * several call it alongside a service function that calls it again, so without
 * memoisation one render is half a dozen `findUnique`s and, on a first sign-in,
 * several racing inserts.
 *
 * IT FAILS CLOSED, and the first version did not. It answered the fixture
 * reader whenever `dataSource` was `"fixtures"` — which an UNSET
 * `DATABASE_URL` is enough to cause — so a deploy that lost its database
 * handed every anonymous visitor a signed-in reader with every capability.
 * That is the `NODE_ENV` mistake this module argues against two paragraphs up,
 * made with a different ambient variable, and it fails open where
 * `/api/cron/poll` fails closed.
 *
 * So the fixture reader is only ever answered when something SAYS SO:
 * `CADENCE_DATA_SOURCE=fixtures`, which is how the parity suite runs both
 * implementations, or `CADENCE_TEST_VIEWER`. A missing database now yields
 * `anon` and the sign-in redirect, which is wrong-but-safe rather than
 * silently public. (Appendix C's "a clone with no database renders every
 * screen" stopped being reachable the moment `clerkMiddleware()` began
 * throwing without its keys — that property is gone for a different reason,
 * and pretending to keep it here is what opened the hole.)
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  /*
   * ONE DOOR, and it is a test switch rather than a mode.
   *
   * `CADENCE_DATA_SOURCE=fixtures` used to open it too, and review was right
   * that it should not: that variable chooses which IMPLEMENTATION answers a
   * query, and nothing about it says who is asking. Honouring it here meant
   * `CADENCE_DATA_SOURCE=fixtures` — a reasonable thing to set while comparing
   * the two services — silently handed every anonymous visitor a signed-in
   * reader with every capability. The same fail-open shape as the
   * `DATABASE_URL` version before it, one door narrower, and no suite needed
   * it: `vitest.setup.ts` sets `CADENCE_TEST_VIEWER` for all of them.
   *
   * The row is NOT created here. The fixture reader is seeded, and a suite that
   * finds it missing should fail loudly rather than have this quietly
   * manufacture the thing it was about to assert on.
   */
  if (process.env[TEST_VIEWER] === "fixture") {
    return { kind: "user", user: sampleUser };
  }

  const { userId } = await auth();
  if (userId === null || userId === undefined) return { kind: "anon" };

  // `rowFor` resolves or throws; there is no third answer. A session that
  // cannot be resolved must not degrade to `anon`, which is the redirect loop.
  return { kind: "user", user: await rowFor(userId) };
});

/**
 * The viewer for a READING SURFACE, or a redirect to sign in.
 *
 * Every screen but `/` is somebody's subscription list (§2), so a visitor with
 * no session has nothing to be shown there. Without this they get the service's
 * `NotAllowedError` — correct, and a 500 page, which is the wrong way to tell
 * someone they need to sign in.
 *
 * SEPARATE FROM `getViewer()` ON PURPOSE. `redirect()` throws a framework
 * signal, which is right in a Server Component and wrong in a Route Handler,
 * where the answer is a 401 with a body a client can read. So the handlers keep
 * calling `getViewer()` and decide for themselves, and `getViewer()` stays a
 * resolver with no opinion about what to do when nobody is there.
 */
export async function requireViewer(): Promise<Extract<Viewer, { kind: "user" }>> {
  const viewer = await getViewer();
  if (viewer.kind === "anon") {
    /*
     * CARRIES WHERE THEY WERE GOING. Clerk reads `redirect_url` and returns
     * them there after signing in; without it every deep link — a feed, a
     * saved article, a health page someone sent you — lands on the fallback
     * and the reader has to find their way back.
     *
     * The path comes from the request's own headers, not from a parameter, so
     * there is nothing a caller could point at another origin. A value Clerk
     * does not recognise as same-origin it ignores.
     */
    const header = await headers();
    const target = header.get(CURRENT_PATH_HEADER);
    const to =
      target !== null && target.startsWith("/") && !target.startsWith("//")
        ? `/sign-in?redirect_url=${encodeURIComponent(target)}`
        : "/sign-in";
    // `redirect` throws, so nothing below runs and no read is attempted with a
    // viewer that would be refused.
    redirect(to);
  }
  return viewer;
}

/** Thrown by `assertCan`. A denial is a 403, never a silent empty result. */
export class NotAllowedError extends Error {
  constructor(readonly capability: Capability) {
    super(`Not allowed: ${capability}`);
    this.name = "NotAllowedError";
  }
}

/**
 * The coarse gate: is this viewer allowed to attempt this at all?
 *
 * THE TABLE IS THIS SHAPE BECAUSE CADENCE HAS TWO ACTORS, not because it is
 * unfinished. A visitor may do nothing — §2 leaves them nothing to do, since
 * every article list is somebody's subscription list and the one public surface
 * (`/`) reads nothing and never calls this — and a signed-in reader may do
 * everything in `CAPABILITIES`. There is no third actor to distinguish: no
 * moderator, no admin, no sharing. The sibling project keys its table on a
 * DERIVED role for exactly that reason, because its §2 names three actors and
 * `Viewer["kind"]` has two values; here the kind IS the role, and inventing a
 * role dimension to make the table look fuller would be inventing a
 * distinction the product does not have.
 *
 * So what makes this enforceable is not the table's shape but its
 * EXHAUSTIVENESS: `capability-denial` iterates `CAPABILITIES` rather than
 * naming a few, so a capability added to the union is covered the day it
 * appears. That is the failure this gate cannot afford — a new write that
 * nobody remembered to deny.
 *
 * THIS IS NOT THE WHOLE CHECK, and the distinction is where authorization bugs
 * live. `assertCan` answers "may a signed-in reader do this kind of thing";
 * whether THIS reader owns THAT row is a per-row question, answered by the
 * `user_id` filter in every query. Passing this gate and then forgetting the
 * filter is the hole, which is why `scopes-authorization.test.ts` exists.
 */
export function assertCan(viewer: Viewer, capability: Capability): void {
  if (viewer.kind === "anon") throw new NotAllowedError(capability);
}

/** Narrowing helper, so callers do not re-implement the check. */
export function requireUser(viewer: Viewer) {
  if (viewer.kind === "anon") throw new NotAllowedError("read");
  return viewer.user;
}
