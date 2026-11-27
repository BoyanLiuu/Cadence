/*
 * The feed-health screen while its evidence loads.
 *
 * THE SLOWEST SET OF READS IN THE PROJECT sits behind this: `listSubscriptions`
 * (~600 ms against the remote pooler, carrying every feed's unread count and
 * today's counters), `listFolders` and `listTicks`. They run in parallel and
 * still take about a second, which is a second of the previous screen unless
 * something stands in for them.
 *
 * NINE COLUMNS, matching the real table's order and the `min-w-[70rem]` it
 * scrolls at, so the horizontal scrollbar does not appear and then vanish. The
 * last column is the "Fetch now" cell: sized like the button, not drawn as one
 * — a placeholder is a promise about content, and a button is chrome whose
 * shape the reader already knows.
 */

/** The real table's nine columns, roughly as wide as what they hold. */
const COLUMNS = ["14rem", "7rem", "8rem", "4rem", "7rem", "4rem", "8rem", "7rem", "8rem"];

export function FeedHealthSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading feed health"
      className="px-lg py-xl gap-2xl mx-auto grid max-w-[1400px]"
    >
      <div className="gap-xs grid" aria-hidden="true">
        {/* "Feeds", and the "12 feeds, 3 needing attention" line under it. */}
        <div className="bg-paper-3 h-9 w-32 animate-pulse rounded-[2px]" />
        <div className="bg-paper-3 h-4 w-80 animate-pulse rounded-[2px]" />
      </div>

      <section className="gap-md grid" aria-hidden="true">
        <div className="bg-paper-3 h-6 w-56 animate-pulse rounded-[2px]" />

        <div className="overflow-x-auto">
          <div className="grid min-w-[70rem]">
            {/* The header row, on the table's heavy rule. */}
            <div className="border-ink py-xs gap-md flex border-b">
              {COLUMNS.map((width, i) => (
                <div
                  key={i}
                  style={{ width }}
                  className="bg-paper-3 h-4 animate-pulse rounded-[2px]"
                />
              ))}
            </div>

            {Array.from({ length: 8 }, (_, row) => (
              <div key={row} className="border-rule py-sm gap-md flex items-start border-b">
                {COLUMNS.map((width, col) => {
                  const last = col === COLUMNS.length - 1;
                  return (
                    <div key={col} style={{ width }} className="gap-3xs grid">
                      <div
                        className={`bg-paper-3 animate-pulse rounded-[2px] ${last ? "h-8 w-24" : "h-4 w-[80%]"}`}
                      />
                      {/* The first column is two lines: the feed's name, then
                          its folder and format. */}
                      {col === 0 && (
                        <div className="bg-paper-3 h-3 w-[55%] animate-pulse rounded-[2px]" />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The tick timeline, and the glossary rail beside it at `lg`. */}
      <section
        className="gap-lg grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
        aria-hidden="true"
      >
        <div className="gap-md grid min-w-0">
          <div className="bg-paper-3 h-6 w-72 animate-pulse rounded-[2px]" />
          <div className="border-rule bg-paper-hi h-40 animate-pulse border" />
        </div>
        <div className="gap-md grid">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="gap-2xs border-rule pb-md grid border-b">
              <div className="bg-paper-3 h-5 w-32 animate-pulse rounded-[2px]" />
              <div className="bg-paper-3 h-4 w-full animate-pulse rounded-[2px]" />
              <div className="bg-paper-3 h-4 w-[72%] animate-pulse rounded-[2px]" />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
