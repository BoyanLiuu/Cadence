import Link from "next/link";

import { signOut } from "@/app/sign-out.action";
import { READER_PATH } from "@/lib/routes";

import { Button } from "@/components/ui/button";

/*
 * The top bar, shared by every signed-in screen (`ux-01` onward). Ported from
 * the prototype's `.bar[data-bar="app"]`.
 *
 * The account name is a prop rather than a session read, because M1 owns the
 * viewer and M11 owns the session — this component must not grow its own data
 * source on the way there.
 */
export function AppBar({
  accountName,
  initials,
  current = "none",
}: {
  accountName: string;
  initials: string;
  /**
   * Which nav item is the current screen.
   *
   * Defaults to "none", NOT to "reader". Defaulting to reader reproduces the
   * bug this prop was added to fix on any screen that forgets to pass it —
   * `/design` did exactly that and marked Reader as current. Marking nothing
   * is merely unhelpful; marking the wrong thing is a lie about where you are.
   */
  current?: "reader" | "saved" | "feeds" | "none";
}) {
  return (
    <header className="ground border-ink sticky top-0 z-[var(--z-sticky-nav)] border-b">
      <div className="gap-xl px-lg flex min-h-[var(--bar-height)] items-center">
        <Link
          href={READER_PATH}
          aria-label="Cadence, the reader"
          className="font-display text-ink hover:text-ink-2 text-xl leading-none tracking-[-0.02em] whitespace-nowrap no-underline"
        >
          Cadence
        </Link>

        <nav aria-label="Main">
          <ul className="gap-lg flex list-none p-0">
            {[
              { href: READER_PATH, label: "Reader", key: "reader" },
              { href: "/saved", label: "Saved", key: "saved" },
              { href: "/settings/feeds", label: "Feeds", key: "feeds" },
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.key === current ? "page" : undefined}
                  className="px-2xs text-ink-2 hover:text-ink aria-[current]:text-ink inline-flex min-h-[var(--control)] items-center text-sm font-medium no-underline transition-colors"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="gap-md ml-auto flex items-center">
          <Button asChild size="sm">
            {/* `/add` — this pointed at `/feeds/new`, which does not exist,
                so the only entry point to the add-feed screen was a 404. */}
            <Link href="/add">Add feed</Link>
          </Button>
          <span className="gap-xs text-ink-2 inline-flex items-center text-sm font-medium whitespace-nowrap">
            <span
              aria-hidden="true"
              className="border-ink bg-paper-hi text-ink grid size-7 place-items-center rounded-[2px] border text-xs font-medium"
            >
              {initials}
            </span>
            <span className="hidden sm:inline">{accountName}</span>
          </span>

          {/*
           * A FORM, not a link, and the distinction is the whole safety of it:
           * Next prefetches `<Link>` on hover, so a `<Link href="/sign-out">`
           * here would sign a reader out for moving the mouse across the nav.
           * Browsers and scanners prefetch too.
           *
           * No `"use client"` anywhere in this file — `<form action={…}>` posts
           * a Server Action without a line of client JavaScript, which is what
           * keeps Clerk's remote bundle off every signed-in page.
           */}
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
