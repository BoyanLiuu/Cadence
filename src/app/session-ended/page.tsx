import type { Metadata } from "next";

import { signOut } from "@/app/sign-out.action";
import { Button } from "@/components/ui/button";

/*
 * `GET /session-ended` — ux-04, for a session Clerk no longer recognises.
 *
 * THE CASE: `auth()` hands back a user id and `currentUser()` then 404s,
 * because the account was deleted or the session revoked while its token was
 * still valid. Clerk's `__session` is a short-lived JWT this app validates
 * locally, so that window is up to a minute wide.
 *
 * WHY NOT `/sign-in?reason=expired`, which is where the prototype puts this
 * copy. Clerk's `<SignIn />` sees a token it still considers valid and bounces
 * the visitor to the fallback redirect — which sends them back to a reading
 * surface, which cannot resolve them, which sends them here. A browser reports
 * that as ERR_TOO_MANY_REDIRECTS. The loop is the whole reason this is its own
 * page.
 *
 * WHAT MAKES IT A WAY OUT rather than a nicer error: the button POSTs the
 * sign-out action, which is the ONLY thing that can clear the cookie. A Server
 * Component cannot — only an action or a route handler may write cookies — so a
 * page that merely explained would leave the reader stuck for the length of the
 * token.
 *
 * The copy is the prototype's sentence, with the action it needs added.
 */

export const metadata: Metadata = {
  title: "Session ended",
  // Nothing here is worth indexing, and it exists only as a destination.
  robots: { index: false },
};

export default function SessionEndedPage() {
  return (
    <div className="ground grid min-h-screen place-items-center">
      <main className="gap-md px-lg grid max-w-[44ch] justify-items-start">
        <h1 className="font-display text-ink m-0 text-3xl tracking-[-0.02em]">
          Your session has ended
        </h1>

        <p className="text-ink-2">
          Sign in again to keep reading. Cadence still has your feeds and everything you had read.
        </p>

        <form action={signOut}>
          {/* The accent is reserved for the one committing action on a page
              (Appendix E), and here that is getting out of this state. */}
          <Button type="submit" className="bg-accent text-accent-ink hover:bg-accent-hover">
            Sign in again
          </Button>
        </form>

        <p className="text-muted text-sm">
          This clears the stale session from this browser and takes you to the home page.
        </p>
      </main>
    </div>
  );
}
