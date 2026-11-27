/*
 * The sidebar's shape, for the FIRST load of the reader only.
 *
 * WHY "FIRST LOAD ONLY". Its `<Suspense>` in `reader-view.tsx` is deliberately
 * UNKEYED, which is the opposite of the choice made for the list and the
 * reading pane. An unkeyed boundary has nothing to re-suspend on a navigation:
 * React keeps the resolved sidebar on screen while the new one loads. That is
 * exactly what is wanted here — the sidebar is the same on every screen in the
 * reader, so re-drawing it as grey bars on each click would be the page
 * flickering rather than a pane loading, and the list skeleton's own note is
 * explicit that the sidebar staying still is what makes the rest read as a
 * pane loading.
 *
 * So this is only ever seen once: on the first paint, where the alternative is
 * an empty column while `listSubscriptions` runs (~600 ms against a remote
 * pooler, the most expensive read in the project).
 *
 * `hidden md:block` and the same sticky column as the real nav, so the grid's
 * first track is the right width immediately and nothing shifts sideways when
 * the feeds arrive.
 */
export function SidebarSkeleton() {
  return (
    <nav
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading feeds"
      className="px-sm pt-md border-rule bg-paper-2 sticky top-[var(--bar-height)] hidden h-[calc(100dvh-var(--bar-height))] overflow-y-auto border-r md:block"
    >
      <div className="gap-md grid" aria-hidden="true">
        {/* "All unread" and its total. */}
        <div className="px-sm py-xs flex items-baseline justify-between">
          <div className="bg-paper-3 h-5 w-28 animate-pulse rounded-[2px]" />
          <div className="bg-paper-3 h-5 w-6 animate-pulse rounded-[2px]" />
        </div>

        {/*
         * Two folders of three feeds. A guess at the shape rather than at the
         * count: enough rows that the column does not grow visibly when the
         * real list arrives, few enough that it does not promise feeds a new
         * reader has not added yet.
         */}
        {[0, 1].map((folder) => (
          <div key={folder} className="gap-2xs grid">
            <div className="px-sm bg-paper-3 h-6 w-32 animate-pulse rounded-[2px]" />
            {[0, 1, 2].map((feed) => (
              <div key={feed} className="px-sm py-xs flex items-baseline justify-between">
                <div
                  className="bg-paper-3 h-4 animate-pulse rounded-[2px]"
                  style={{ width: `${70 - feed * 12}%` }}
                />
                <div className="bg-paper-3 h-4 w-5 animate-pulse rounded-[2px]" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
