"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/*
 * Signing out.
 *
 * NOT CLERK'S `<SignOutButton>`. That is a client component, and
 * `ClerkProvider` is scoped to `/sign-in` and `/sign-up` so the reader never
 * loads Clerk's remote bundle on a page that renders publisher text. Importing
 * it into the app bar would undo that for every signed-in screen.
 *
 * AN ACTION, NOT A ROUTE, which differs from the sibling project on purpose.
 * It went with a route and a hand-written `sameOrigin` check because its own
 * header could not afford the import; Cadence's app bar is a Server Component,
 * so an action costs it no client JavaScript — and Next checks an action's
 * `Origin` itself. Its comment on that check is the argument: "two copies of a
 * security check is two chances for one of them to be fixed and the other not".
 * This way there is no copy to keep.
 *
 * A FORM POST, NEVER A GET, and this is the trap worth naming. Next prefetches
 * `<Link>` on hover, so a `<Link href="/sign-out">` in a header signs a reader
 * out for moving the mouse across the nav. Browsers and scanners prefetch too.
 * An action is only ever reached by a submission, which is what makes it safe
 * here — the hazard belongs to the route shape this avoids.
 *
 * REVOKE FIRST, THEN CLEAR. The two steps do different jobs and only together
 * add up to "signed out":
 *
 *   Clearing the cookies alone logs THIS browser out and leaves the session
 *   alive on Clerk's side, so a copy of the cookie taken beforehand still
 *   works. That is the one thing a sign-out button must not permit.
 *
 *   Revoking alone is authoritative but not immediate: `__session` is a
 *   short-lived JWT this app validates locally, so a revoked session keeps
 *   being accepted until the token expires. Someone who clicks "sign out" and
 *   stays signed in for another minute is entitled to call that broken.
 */

/**
 * Cookie name prefixes Clerk owns.
 *
 * MATCHED BY PREFIX RATHER THAN LISTED. `__session` and `__client_uat` are the
 * documented names and `__clerk_db_jwt` is the development instance's, but a
 * hardcoded list silently stops clearing a cookie the day Clerk adds or renames
 * one — and the failure mode is a sign-out that looks like it worked. Reading
 * the names off the request means whatever this instance actually set is what
 * gets cleared.
 */
const CLERK_COOKIE_PREFIXES = ["__session", "__client_uat", "__clerk", "__refresh"];

export async function signOut(): Promise<void> {
  /*
   * `auth()` IS INSIDE THE TRY TOO. It was outside, so a Clerk key or
   * middleware failure threw before a single cookie was cleared — exactly the
   * "trapped behind a button that throws" state this file rules out two
   * paragraphs up, reachable through the one call that looked too simple to
   * fail.
   */
  try {
    const { sessionId } = await auth();

    if (sessionId !== null && sessionId !== undefined) {
      await (await clerkClient()).sessions.revokeSession(sessionId);
    }
  } catch (error) {
    /*
     * NOT FATAL, and the order is why. The cookies are cleared below
     * regardless, so a Clerk outage still ends the session in this browser
     * rather than trapping someone signed in behind a button that throws.
     * Logged because the session outliving the click is a real if narrow
     * exposure, and nothing else would record it.
     */
    console.error("sign-out: ending the session with Clerk failed", error);
  }

  /*
   * NO `Domain` ON THE DELETE, which is a real limit rather than an oversight.
   * `delete(name)` evicts a host-only cookie, and Clerk's PRODUCTION instances
   * can scope theirs to a parent domain — those would survive this and leave
   * the reader signed in until the JWT expired. It does not arise here because
   * Cadence stays on the development instance, where cookies are host-only;
   * that is a recorded decision, not an accident. If a production instance ever
   * exists, this needs the domain passed explicitly.
   */
  const jar = await cookies();
  for (const cookie of jar.getAll()) {
    if (CLERK_COOKIE_PREFIXES.some((prefix) => cookie.name.startsWith(prefix))) {
      jar.delete(cookie.name);
    }
  }

  /*
   * To `/`, the one page that renders without a session. Outside any try —
   * `redirect` signals by throwing, so catching it would report the sign-out as
   * a failure.
   */
  redirect("/");
}
