import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

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
 * fixtures, so there is no viewer to resolve and nothing to leak.
 *
 * ---------------------------------------------------------------------------
 * IT SHOWS THE PRODUCT NOW, which is the change at M15
 * ---------------------------------------------------------------------------
 * This page led with a DRAWING of deduplication — 432px of diagram before the
 * h1 said what Cadence is — and never showed the reader at all. A feed reader
 * whose home page contained no feed reader. These are the real screens:
 * `/reader` with an article open, and `/settings/feeds`.
 *
 * THE DRAWING IS GONE RATHER THAN DEMOTED, because the product does its job
 * better. The reading pane's "Also in 2 feeds: one row, 3 arrivals" panel
 * shows three real addresses with their schemes and tracking parameters struck
 * through and the key they all reduce to — exactly what the diagram
 * illustrated, except it is the working screen. An illustration of something
 * you can photograph is a weaker claim than the photograph.
 *
 * SHOT FROM THE FIXTURE READER (`CADENCE_TEST_VIEWER=fixture`), not from a
 * real account, and that is a privacy decision rather than a convenience:
 * these images ship to every visitor, so they must contain no real person's
 * feeds, folders or reading. Everything in them belongs to Elif Brandt, who
 * does not exist.
 *
 * A LIGHT PAGE, DECIDED BY THE SCREENSHOTS. A graphite ground was on the table
 * and the product's own screens are paper-white — a dark page would set them in
 * a frame they fight, and would promise an interface the reader does not have.
 *
 * The headline and lead are still the approved comp's (`hallmark/index.html`);
 * everything below them is new.
 */

export const metadata: Metadata = {
  // Overrides the root template's "%s · Cadence", which would read
  // "Cadence · Cadence" here.
  title: "Cadence — one row per article, however many feeds carry it",
  description:
    "A personal feed reader that shows each article once, however many feeds carry it, and keeps an unread count you can trust.",
};

/** What the product does. Each line is something the code actually does. */
const CLAIMS = [
  {
    title: "Every article once",
    body: "Three feeds carrying one story become one row, matched on the publisher’s id, then the address with its tracking stripped, then the text.",
  },
  {
    title: "An unread count that is true",
    body: "Counted from what you have read, every time it is shown. Never a stored number that drifts away from the list.",
  },
  {
    title: "Teaser feeds, read in full",
    body: "A feed that sends one paragraph has the article fetched once, on open, and kept. A gated one says so.",
  },
];

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

      <main>
        {/*
         * THE HERO IS THE PRODUCT, and the screenshot is not shrunk to fit a
         * column. A 1440-wide screen squeezed into a 628px half is a picture of
         * software nobody can read — so it runs at close to its own size and is
         * CLIPPED by the right edge instead. What survives the crop is the
         * sidebar, the list and the opening of the reading pane: the parts that
         * say "this is a reader".
         */}
        <section className="py-2xl gap-xl grid lg:min-h-[calc(100vh-57px)] lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:items-center lg:gap-0">
          <div className="px-lg lg:pr-xl mx-auto w-full max-w-[1180px] lg:mx-0 lg:ml-auto lg:max-w-[30rem]">
            <p className="text-muted num mb-md text-xs tracking-[0.1em] uppercase">
              12 feeds · 81 unread · one row per article
            </p>

            <h1 className="font-display text-ink m-0 text-5xl leading-[1.05] tracking-[-0.02em] text-balance sm:text-6xl">
              Three feeds, one story, one unread.
            </h1>

            <p className="lead text-ink-2 mt-md">
              Cadence keeps one row per article, so your unread count stays true.
            </p>

            {/*
             * A LINK, not Clerk's own button, and not named after one provider.
             *
             * The comp predates Clerk and drew its own GitHub button and email
             * field, because the prototype owned the whole sign-in surface.
             * Clerk owns the credential UI now, and `/sign-in` renders GitHub,
             * Google, an email code and a password — so a second set here would
             * be two sign-in surfaces to keep in step.
             *
             * The label is "Sign in", not the comp's "Continue with GitHub": a
             * button named after one provider promises that provider, and this
             * one opens a card offering four ways in.
             *
             * It also keeps this page free of Clerk's remote bundle, which
             * matters most on the one page whose job is to load fast for
             * someone who has never been here.
             */}
            <Link
              href="/sign-in"
              className="bg-accent text-accent-ink hover:bg-accent-hover px-lg mt-lg inline-flex h-10 items-center rounded-[2px] text-sm font-medium no-underline transition-transform hover:-translate-y-0.5"
            >
              Sign in
            </Link>

            <p className="text-ink-2 mt-sm text-xs">With GitHub, Google, or your email address.</p>
          </div>

          {/*
           * TWO SCREENSHOTS, ONE PER SHAPE, and the phone one is not a crop of
           * the other — it is the app's own mobile layout, shot at 390.
           *
           * THE DESKTOP SHOT ON A PHONE WAS UNREADABLE: 1440 pixels of
           * three-pane reader scaled into 342 is a grey smudge. That is worse
           * than no picture, because it says the product is unreadable. The
           * real app collapses to one column on a phone, so the honest small
           * image is that screen.
           *
           * CLIPPED, NOT SCALED, on the wide one: `overflow-hidden` on the
           * column with the image at its own width, so the sidebar, the list
           * and the opening of the reading pane stay legible and the rest is
           * implied by the crop.
           */}
          <div className="px-lg lg:overflow-hidden lg:px-0">
            <div className="border-rule bg-paper-hi mx-auto w-full max-w-[22rem] overflow-hidden rounded-[2px] border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-12px_rgba(0,0,0,0.18)] lg:mx-0 lg:w-[1440px] lg:max-w-none">
              <Image
                src="/shots/reader-phone.webp"
                alt="Cadence on a phone: the unread list, with “Council votes to raise the tidal barrier by a metre” carrying a badge reading “Also in 2 feeds”."
                width={390}
                height={844}
                priority
                sizes="22rem"
                className="block h-auto w-full lg:hidden"
              />
              <Image
                src="/shots/reader.webp"
                alt="Cadence's reading screen: a sidebar of folders with unread counts, the unread list, and one article open beside a panel reading “Also in 2 feeds: one row, 3 arrivals” that shows the same story's three addresses with their schemes and tracking parameters struck through."
                width={1440}
                height={900}
                /* The hero image on a wide screen, so neither lazy nor deferred. */
                priority
                sizes="1440px"
                className="hidden h-auto w-full lg:block"
              />
            </div>
          </div>
        </section>

        <section className="container-page py-2xl" aria-labelledby="what-it-does">
          <h2
            id="what-it-does"
            className="font-display text-ink border-ink pb-sm mb-xl m-0 border-b text-2xl tracking-[-0.01em]"
          >
            What it does
          </h2>

          {/*
           * THREE, not six. The previous version put 210 words of prose on one
           * screen with no pictures; a section like this gets 60 to 80. The
           * three that survived are the ones the product cannot be explained
           * without — the others were true, and were detail.
           */}
          <div className="gap-xl grid sm:grid-cols-3">
            {CLAIMS.map((claim) => (
              <div key={claim.title} className="gap-2xs grid">
                <h3 className="text-ink m-0 text-base">{claim.title}</h3>
                <p className="text-ink-2 m-0 max-w-[40ch] text-sm leading-[1.6]">{claim.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="container-page pb-2xl" aria-labelledby="evidence">
          <h2
            id="evidence"
            className="font-display text-ink border-ink pb-sm mb-md m-0 border-b text-2xl tracking-[-0.01em]"
          >
            It shows its own evidence
          </h2>
          <p className="text-ink-2 mb-lg max-w-[60ch] text-sm leading-[1.6]">
            Every check a feed has had: what answered, how much collapsed into rows you already had,
            and which rule collapsed it. A feed that has stopped says when and why.
          </p>

          <div className="border-rule bg-paper-hi overflow-hidden rounded-[2px] border">
            <Image
              src="/shots/health.webp"
              alt="Cadence's feed health table: twelve feeds with their state, last check, the share of checks that returned not-modified, how much each collapsed, and when each is next due. Three are flagged — one not a feed, one stopped on 404s, one retrying after a timeout."
              width={1440}
              height={900}
              sizes="(min-width: 1024px) 1180px, 100vw"
              className="block h-auto w-full"
            />
          </div>
        </section>

        {/*
         * A FOOTER, which this page did not have at all — so there was nowhere
         * for the repository, and nothing closed the page off.
         */}
        <footer className="border-ink border-t">
          <div className="container-page py-lg gap-sm text-muted flex flex-wrap items-center justify-between text-xs">
            <span>
              A personal feed reader. The screens above are the real app, with a sample reader’s
              feeds.
            </span>
            <a
              href="https://github.com/BoyanLiuu/Cadence"
              className="text-ink-2 hover:text-ink"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source on GitHub
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
