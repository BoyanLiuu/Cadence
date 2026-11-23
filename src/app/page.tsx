import type { Metadata } from "next";
import Link from "next/link";

import { HomeScene } from "./home-scene";

/*
 * `GET /` — the public home page.
 *
 * WHY THIS ROUTE EXISTS, since M0–M10 had the reader here. §2 says there is no
 * public reading surface: every article list is somebody's subscription list.
 * That leaves a visitor with no session nowhere to land — and "nowhere" would
 * mean either a 403 or a redirect straight into Clerk's card, before anything
 * had said what the product is. So the reader moved to `/reader` and this took
 * its place, which also means the provider that serves Clerk's UI can never
 * share a route with the reader (see `clerk-ui-scope.test.ts`).
 *
 * PUBLIC AND STATIC. Nothing here reads the session, the database or the
 * fixtures, so there is no viewer to resolve and nothing to leak. The figure
 * is a drawing of the fixture corpus's syndicated story, not a query for it.
 *
 * The copy is the approved comp's, from `hallmark/index.html` — the headline,
 * the lead, and the GitHub call to action, which the prototype wrote as
 * `/api/auth/signin/github`.
 */

export const metadata: Metadata = {
  // Overrides the root template's "%s · Cadence", which would read
  // "Cadence · Cadence" here.
  title: "Cadence — one row per article, however many feeds carry it",
};

export default function HomePage() {
  return (
    <div className="ground min-h-screen">
      <header className="border-ink border-b">
        <div className="container-page py-md flex items-center justify-between">
          <span className="font-display text-ink text-xl leading-none tracking-[-0.02em]">
            Cadence
          </span>
          <Link href="/sign-in" className="text-ink text-sm">
            Sign in
          </Link>
        </div>
      </header>

      <main className="container-page py-2xl">
        <HomeScene />

        <div className="gap-xl mt-2xl grid items-end lg:grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,0.8fr)]">
          <h1 className="font-display text-ink m-0 text-5xl leading-[1.05] tracking-[-0.02em] text-balance sm:text-6xl">
            Three feeds, one story, one unread.
          </h1>

          <div className="hidden lg:block" aria-hidden="true" />

          <div>
            <p className="lead text-ink mt-0">
              Cadence keeps one row per article, so your unread count stays true.
            </p>

            {/*
             * A LINK, not Clerk's own button, and the reason is worth keeping.
             *
             * The comp predates Clerk and drew its own GitHub button and email
             * field, because the prototype owned the whole sign-in surface.
             * Clerk owns the credential UI now, and `/sign-in` already renders
             * GitHub, Google and an email field — so a second set here would be
             * two sign-in surfaces to keep in step, and the email input would
             * have to either post somewhere real or be the kind of control that
             * looks live and is not.
             *
             * It also keeps this page free of Clerk's remote bundle, which
             * matters most on the one page whose job is to load fast for
             * someone who has never been here.
             */}
            <Link
              href="/sign-in"
              className="bg-accent text-accent-ink hover:bg-accent-hover px-lg mt-lg inline-flex h-10 items-center rounded-[2px] text-sm font-medium no-underline"
            >
              Continue with GitHub
            </Link>

            <p className="text-ink-2 mt-sm text-xs">
              Or sign in with Google, or have a link emailed to you. No password.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
