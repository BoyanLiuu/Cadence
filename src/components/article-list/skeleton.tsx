/*
 * What the list pane shows while the next scope is being fetched.
 *
 * WHY IT EXISTS. A sidebar click costs ~220 ms in production — one round trip
 * to a remote Postgres for the rows and the count — and prefetch does not
 * remove it: a folder navigates by search param, so the server component has
 * to re-run for `?folder=2` whatever was prefetched. Measured at 305 ms from
 * click to new heading, with a 500 ms hover beforehand. With nothing on screen
 * changing, that reads as a click that did not register.
 *
 * IN THE LIST, NOT ON THE THING CLICKED. The first version put a spinner in
 * the sidebar's unread count, which answered "your click landed" — but the
 * question a reader actually has is "where are my articles", and the answer
 * belongs where the articles will appear. The sidebar also stays perfectly
 * still this way, which is what makes the change feel like a pane loading
 * rather than the page jumping.
 *
 * ROWS RATHER THAN A SPINNER IN A BOX. The shape of what is coming is already
 * known — a header, a toggle, a search field, then rows of two lines — so the
 * skeleton is that shape. A centred spinner would discard information we have
 * and make the pane's height jump when the real list arrives.
 *
 * NOT ANIMATED BEYOND A PULSE. `animate-pulse` is opacity only, so it costs no
 * layout and settles under `prefers-reduced-motion` with the rest of the
 * project's motion (`globals.css`).
 */
export function ArticleListSkeleton() {
  return (
    <section
      /*
       * `aria-busy` with a live region, so a screen reader is told the list is
       * loading ONCE rather than having eight placeholder rows read out. The
       * bars themselves are `aria-hidden`: they are the shape of content, not
       * content.
       */
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading articles"
      className="border-rule min-h-[calc(100dvh-var(--bar-height))] border-r"
    >
      <div className="px-lg py-md border-rule gap-sm grid border-b" aria-hidden="true">
        <div className="bg-paper-3 h-8 w-40 animate-pulse rounded-[2px]" />
        <div className="bg-paper-3 h-4 w-20 animate-pulse rounded-[2px]" />
        <div className="gap-xs mt-xs flex">
          <div className="bg-paper-3 h-9 w-28 animate-pulse rounded-[2px]" />
          <div className="bg-paper-3 ml-auto h-9 w-28 animate-pulse rounded-[2px]" />
        </div>
      </div>

      {/*
       * Eight rows: enough to fill the pane at the common heights without
       * being so many that the real list is shorter than the skeleton and the
       * pane shrinks on arrival.
       */}
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="px-lg py-md border-rule gap-2xs grid border-b" aria-hidden="true">
          <div className="flex items-baseline justify-between">
            <div className="bg-paper-3 h-3 w-24 animate-pulse rounded-[2px]" />
            <div className="bg-paper-3 h-3 w-10 animate-pulse rounded-[2px]" />
          </div>
          <div className="bg-paper-3 mt-3xs h-5 w-[85%] animate-pulse rounded-[2px]" />
          <div className="bg-paper-3 h-4 w-[60%] animate-pulse rounded-[2px]" />
        </div>
      ))}
    </section>
  );
}
