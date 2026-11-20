import Link from "next/link";

import { Button } from "@/components/ui/button";

/*
 * The top bar, shared by every signed-in screen (`ux-01` onward). Ported from
 * the prototype's `.bar[data-bar="app"]`.
 *
 * The account name is a prop rather than a session read, because M1 owns the
 * viewer and M11 owns the session — this component must not grow its own data
 * source on the way there.
 */
export function AppBar({ accountName, initials }: { accountName: string; initials: string }) {
  return (
    <header className="ground border-ink sticky top-0 z-[var(--z-sticky-nav)] border-b">
      <div className="gap-xl px-lg flex min-h-[var(--bar-height)] items-center">
        <Link
          href="/"
          aria-label="Cadence, the reader"
          className="font-display text-ink hover:text-ink-2 text-xl leading-none tracking-[-0.02em] whitespace-nowrap no-underline"
        >
          Cadence
        </Link>

        <nav aria-label="Main">
          <ul className="gap-lg flex list-none p-0">
            {[
              { href: "/", label: "Reader", current: true },
              { href: "/saved", label: "Saved", current: false },
              { href: "/settings/feeds", label: "Feeds", current: false },
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.current ? "page" : undefined}
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
            <Link href="/feeds/new">Add feed</Link>
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
        </div>
      </div>
    </header>
  );
}
