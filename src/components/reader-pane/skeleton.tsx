/*
 * What the reading pane shows while the article it was asked for loads.
 *
 * WHY IT EXISTS. Opening an article is a SEARCH-PARAM navigation
 * (`?article=123`), so `loading.tsx` never fires and React holds the resolved
 * tree on screen while the new one renders — which meant a click showed the
 * PREVIOUS article for the length of a server round trip, then swapped. Not a
 * blank wait: a wait during which the screen confidently displayed the wrong
 * piece. A reader who clicks twice because "it didn't register" then lands
 * somewhere they did not choose.
 *
 * Measured against the remote pooler: ~240 ms for the article itself and
 * ~600 ms for the shell's own reads, so this is most of a second of the wrong
 * headline.
 *
 * THE PANE'S OWN SHAPE, down to the container. The real pane is a `<article>`
 * with `px-2xl pt-xl pb-3xl`, a `max-w-[44rem]` column inside it and a
 * `gap-md` rhythm — all repeated here, so the skeleton occupies the same box
 * and nothing shifts when the text arrives. `hidden lg:block` matters as much:
 * the reading pane does not exist below `lg`, and a skeleton that appeared
 * there would promise a pane the layout has no column for.
 *
 * ONE FEWER THING THAN THE ARTICLE HAS. The byline and buttons are drawn
 * because every article has them; the §6.5 notice is not, because only some
 * articles do, and a placeholder for something that may not arrive is a
 * flicker rather than a promise.
 */
export function ReaderPaneSkeleton() {
  return (
    <article
      /*
       * Announced once, as a sentence. `aria-busy` with a polite live region
       * and a label is what a screen reader reads; the bars are `aria-hidden`
       * because they are the shape of content, not content.
       */
      aria-busy="true"
      aria-live="polite"
      aria-label="Opening the article"
      className="px-2xl pt-xl pb-3xl sticky top-[var(--bar-height)] hidden h-[calc(100dvh-var(--bar-height))] min-w-0 overflow-y-auto lg:block"
    >
      <div className="gap-md grid max-w-[44rem]" aria-hidden="true">
        {/* The feed's name. */}
        <div className="bg-paper-3 h-4 w-48 animate-pulse rounded-[2px]" />

        {/* The headline, which is `text-5xl` and usually wraps to two lines. */}
        <div className="gap-2xs grid">
          <div className="bg-paper-3 h-11 w-[88%] animate-pulse rounded-[2px]" />
          <div className="bg-paper-3 h-11 w-[52%] animate-pulse rounded-[2px]" />
        </div>

        {/* The byline and reading time, which are one line of small text. */}
        <div className="bg-paper-3 h-4 w-72 animate-pulse rounded-[2px]" />

        {/*
         * WHERE THE BUTTONS GO — empty, and the rule they sit on.
         *
         * NOT pulsing bars: a placeholder is a promise about content, and
         * Save · Mark read · Open original are chrome whose shape the reader
         * already knows. And not the REAL buttons either, which is the
         * difference from `opening.tsx` — that one has an article id and a
         * saved/read state read off the clicked row, so it can render them
         * working. This state is the one with nothing to go on, and a Save
         * button with no article to save is worse than no button.
         *
         * The height is held either way, so the body does not jump 49 px when
         * the real row arrives.
         */}
        <div className="pb-md border-rule flex border-b">
          <div className="h-9" />
        </div>

        {/*
         * Three paragraphs of body prose. More than the extraction skeleton's
         * two, because that one sits BELOW a teaser the reader can already
         * read and this one is the whole pane — too little here and the pane
         * looks like a short article rather than a loading one.
         */}
        {[
          ["100%", "96%", "99%", "93%", "61%"],
          ["100%", "94%", "98%", "48%"],
          ["100%", "97%", "72%"],
        ].map((lines, p) => (
          <div key={p} className="gap-2xs grid">
            {lines.map((width, i) => (
              <div
                key={i}
                style={{ width }}
                className="bg-paper-3 h-4 animate-pulse rounded-[2px]"
              />
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}
