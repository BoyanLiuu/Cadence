/*
 * The saved shelf while it loads.
 *
 * WHY IT IS NEEDED. This page's reads are the heaviest of any single screen:
 * `listSubscriptions` (~600 ms against the remote pooler) and then EVERY page
 * of saved articles, because the counts and the tabs are derived from all of
 * them rather than from one page. Awaited before anything rendered, a click on
 * "Saved" in the nav left the previous screen up for over a second.
 *
 * THE SHAPE IS THIS PAGE'S: a heading and a count line, the three joined count
 * tabs, then rows under a heavy top rule, in the same container and max width.
 * So the real shelf arrives into the space already laid out for it.
 *
 * `animate-pulse` is opacity only, so it costs no layout and settles under
 * `prefers-reduced-motion` with the rest of the project's motion.
 */
export function SavedSkeleton() {
  return (
    <main
      /*
       * Announced once, as a sentence, with the bars `aria-hidden`: they are
       * the shape of content, not content.
       */
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading saved articles"
      className="px-lg py-xl gap-lg mx-auto grid max-w-[1180px]"
    >
      <div className="gap-xs grid" aria-hidden="true">
        {/* "Saved for later", and the "12 articles, 3 unread" line. */}
        <div className="bg-paper-3 h-9 w-56 animate-pulse rounded-[2px]" />
        <div className="bg-paper-3 h-4 w-40 animate-pulse rounded-[2px]" />
      </div>

      {/* All · Unread · Read, which render as one joined control. */}
      <div className="bg-paper-3 h-8 w-64 animate-pulse justify-self-start rounded-[2px]" />

      {/*
       * Six rows, in the real list's five-column grid at `md` and up. Enough
       * to fill the first screen without a three-article shelf visibly
       * shrinking when it arrives.
       */}
      <ul className="border-ink m-0 grid list-none border-t p-0" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="border-rule border-b">
            <div className="gap-sm px-sm py-md grid items-baseline md:grid-cols-[minmax(0,1fr)_14rem_7rem_5rem_5rem]">
              {/* The title is `text-xl`, so its bar is taller than the rest. */}
              <div
                className="bg-paper-3 h-6 animate-pulse rounded-[2px]"
                style={{ width: `${88 - (i % 3) * 14}%` }}
              />
              <div className="bg-paper-3 h-4 w-40 animate-pulse rounded-[2px]" />
              <div className="bg-paper-3 h-4 w-24 animate-pulse rounded-[2px]" />
              <div className="bg-paper-3 h-4 w-12 animate-pulse rounded-[2px]" />
              <div className="bg-paper-3 h-4 w-14 animate-pulse rounded-[2px]" />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
