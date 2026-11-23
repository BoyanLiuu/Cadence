/*
 * The proof figure on the home page: one story, three feeds, one unread.
 *
 * STATIC BY DESIGN. Every string here is a literal, not a read — `/` renders
 * for a visitor with no session, and §2 says there is no public reading
 * surface, so this page must not touch `article-service` at all. It describes
 * the fixture corpus's syndicated story because that is the case the whole
 * identity ladder exists for, but it is a DRAWING of it rather than a query.
 *
 * Ported from `hallmark/index.html`'s `@scene` block. The struck-through parts
 * of each address are the canonicalisation rules doing their work (M3's
 * `canonicalUrl`), and they are the reason all three arrivals land on one row:
 * scheme, `www.`, a trailing slash, `utm_*`, `ref` and the fragment are all
 * set aside before the key is taken.
 */

type Arrival = {
  feed: string;
  arrived: string;
  /** The address in parts, so the set-aside ones can be struck through. */
  url: { text: string; kept: boolean }[];
  why: string;
};

const ARRIVALS: Arrival[] = [
  {
    feed: "Harbour Wire",
    arrived: "09:22",
    url: [
      { text: "https://", kept: false },
      { text: "harbourwire.example/2026/11/12/tidal-barrier-vote", kept: true },
    ],
    why: "First in, owns the row",
  },
  {
    feed: "The Lowland Courier",
    arrived: "09:26",
    url: [
      { text: "http://", kept: false },
      { text: "www.", kept: false },
      { text: "harbourwire.example/2026/11/12/tidal-barrier-vote", kept: true },
      { text: "/", kept: false },
      { text: "?utm_source=lowland&utm_medium=rss", kept: false },
    ],
    why: "Set aside: the scheme, www., the trailing slash, utm_source and utm_medium",
  },
  {
    feed: "Northgate Daily",
    arrived: "09:33",
    url: [
      { text: "https://", kept: false },
      { text: "harbourwire.example/2026/11/12/tidal-barrier-vote", kept: true },
      { text: "?ref=northgate", kept: false },
      { text: "#top", kept: false },
    ],
    why: "Set aside: the scheme, ref and the fragment",
  },
];

const STORY = "Council votes to raise the tidal barrier by a metre";

/**
 * An address split at the points it may wrap, as `<wbr>` opportunities.
 *
 * Without this the column is narrow enough that `break-all` splits mid-token —
 * `utm_source=lowla / nd&utm_medium=rss` — which makes the one thing this
 * figure has to be legible about, the shape of a URL, hard to read. The comp
 * places its own `<wbr>`s at exactly these characters.
 */
function Breakable({ text }: { text: string }) {
  // Kept after the delimiter for `/`, before it for the rest, so a line never
  // begins with a stray slash or ends mid-parameter.
  const pieces = text.split(/(?<=\/)|(?=[?&#])/);
  return (
    <>
      {pieces.map((piece, i) => (
        <span key={i}>
          {piece}
          {i < pieces.length - 1 && <wbr />}
        </span>
      ))}
    </>
  );
}

/**
 * The figure's alternative text, taken from the comp's own `data-alt`.
 *
 * The whole thing is ONE illustration, announced once. The first version left
 * its ~40 fragments exposed and labelled the figure from the caption, so a
 * screen reader walked "https://", "harbourwire.example", "/2026/", "/11/" one
 * piece at a time — a guided tour of URL punctuation. The comment claimed the
 * parts were decorative while nothing marked them so; this is that claim
 * actually implemented.
 */
const SCENE_ALT =
  "One news story arriving from three feeds under three different addresses, " +
  "the scheme and tracking parameters struck out, collapsing into a single " +
  "unread row in the reading list: 3 arrivals, 1 key, 1 row, 1 unread.";

export function HomeScene() {
  return (
    <figure className="m-0" role="img" aria-label={SCENE_ALT}>
      <figcaption
        aria-hidden="true"
        className="gap-md border-rule text-ink-2 pb-xs mb-md flex flex-wrap justify-between border-b text-xs"
      >
        <span>One story from three feeds, arriving 12 Nov, 09:22 to 09:33 UTC</span>
        <span>Address rules, version 1</span>
      </figcaption>

      <div className="gap-md grid items-stretch lg:grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,0.8fr)]">
        <ol className="gap-sm m-0 grid list-none p-0" aria-hidden="true">
          {ARRIVALS.map((arrival) => (
            <li
              key={arrival.feed}
              className="border-rule bg-paper px-md py-sm rounded-[2px] border"
            >
              <p className="text-ink-2 mb-2xs flex justify-between gap-2 text-xs">
                <span>{arrival.feed}</span>
                <span className="num">arrived {arrival.arrived}</span>
              </p>
              <p className="font-display text-ink mb-2xs text-lg leading-snug">{STORY}</p>
              <p className="mb-2xs font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
                {arrival.url.map((part, i) =>
                  part.kept ? (
                    <span key={i} className="text-ink">
                      <Breakable text={part.text} />
                    </span>
                  ) : (
                    <del key={i} className="text-accent decoration-accent">
                      <Breakable text={part.text} />
                    </del>
                  ),
                )}
              </p>
              <p className="text-ink-2 text-xs">{arrival.why}</p>
            </li>
          ))}
        </ol>

        {/*
         * THE CONNECTOR, and it carries the argument rather than decorating
         * it: without the bracket gathering three arrivals into one line, the
         * figure is two unrelated lists side by side and the reader has to be
         * told what to notice. Drawn rather than described, and hidden below
         * `lg` where the columns stack and a horizontal bracket would point
         * nowhere — the caption and the summary line still say it in words.
         */}
        <div className="relative hidden lg:block" aria-hidden="true">
          <svg
            viewBox="0 0 100 300"
            preserveAspectRatio="none"
            focusable="false"
            className="text-accent h-full w-full"
          >
            <path
              d="M0 50H52V250H0M52 150H100"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span className="bg-paper text-ink-2 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-1 text-[0.625rem] whitespace-nowrap">
            same key
          </span>
        </div>

        {/*
         * The outcome: one row, one unread. Deliberately NOT a live reader —
         * see the note at the top of this file.
         */}
        <div className="self-center" aria-hidden="true">
          <div className="border-rule bg-paper rounded-[2px] border">
            <p className="gap-md border-rule px-md py-sm flex items-baseline justify-between border-b">
              <span className="font-display text-ink text-2xl">All unread</span>
              <span className="num font-outlier text-ink text-2xl">19</span>
            </p>
            <ol className="m-0 list-none p-0">
              <li className="border-rule px-md py-sm border-b last:border-b-0">
                <p className="text-ink-2 mb-2xs flex justify-between gap-2 text-xs">
                  <span>Harbour Wire</span>
                  <span className="num">published 09:12</span>
                </p>
                <p className="font-display text-ink mb-2xs text-lg leading-snug">{STORY}</p>
                <p className="border-rule text-ink-2 inline-block rounded-[2px] border px-1.5 py-0.5 text-xs">
                  Also in 2 feeds
                </p>
              </li>
              <li className="px-md py-sm">
                <p className="text-ink-2 mb-2xs flex justify-between gap-2 text-xs">
                  <span>The Lowland Courier</span>
                  <span className="num">published 09:02</span>
                </p>
                <p className="font-display text-ink text-lg leading-snug">
                  Market square to close for resurfacing
                </p>
              </li>
            </ol>
          </div>
          <p className="text-ink-2 mt-xs text-right text-xs">3 arrivals, 1 key, 1 row, 1 unread</p>
        </div>
      </div>
    </figure>
  );
}
