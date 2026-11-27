import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";

import { ArticleActions } from "./article-actions";
import { readingMinutes, stamp } from "./format";

/*
 * The pane while the server fetches an article the LIST ALREADY DESCRIBED.
 *
 * WHY THIS IS NOT THE SKELETON. `ReaderPaneSkeleton` draws grey bars where the
 * feed name, the headline and the byline go — and every one of those is a fact
 * the row the reader just clicked was already displaying. Covering known text
 * with a placeholder is not caution, it is throwing information away and then
 * animating the hole where it was. The reader clicked a headline; the pane
 * should be headed by that headline.
 *
 * WHAT IS REAL HERE: the feed's name, the title, the author, the published
 * stamp and the reading time. All five come from the clicked row's own props
 * (`data-*` on the `<li>`), so they are the SAME VALUES the server is about to
 * send — the h1 does not re-wrap and nothing shifts when it arrives.
 *
 * WHAT STAYS A PLACEHOLDER, and this is a correctness line rather than an
 * effort one:
 *
 *   THE BODY, and only the body. Genuinely unknown at click time: a teaser, an
 *   extracted page, or neither.
 *
 * The buttons are REAL and working — see the note on them below, and the
 * correction in `article-list/index.tsx` of the reasoning that once withheld
 * them.
 *
 * So this is the honest division — everything the click already knew, drawn;
 * everything that needs the server, waiting.
 */
export type OpeningArticle = {
  id: number;
  title: string;
  feedTitle: string;
  publishedAt: string;
  author: string | null;
  words: number;
  /** Null when the feed gave the item no address of its own. */
  url: string | null;
  read: boolean;
  saved: boolean;
};

export function ReaderPaneOpening({ article }: { article: OpeningArticle }) {
  /*
   * An unparseable date prints nothing rather than "Invalid Date". The value
   * comes from an attribute, so it is a string from the DOM until proven
   * otherwise — the same care `shortDate` takes in the add-feed cards.
   */
  const published = Number.isNaN(new Date(article.publishedAt).getTime())
    ? null
    : stamp(article.publishedAt);

  return (
    <article
      /*
       * `aria-busy` WITHOUT a live region, which is the difference from the
       * skeleton: there is real text here and a screen reader should read it
       * as the article's heading, not be told a region is loading and have the
       * heading announced again a second later when the server's copy lands.
       */
      aria-busy="true"
      className="px-2xl pt-xl pb-3xl sticky top-[var(--bar-height)] hidden h-[calc(100dvh-var(--bar-height))] min-w-0 overflow-y-auto lg:block"
    >
      {/* The real pane's container, token for token, so nothing moves. */}
      <div className="gap-md grid max-w-[44rem]">
        <p className="text-sm font-medium">{article.feedTitle}</p>
        <h1 className="text-5xl leading-[1.02]">{article.title}</h1>

        <p className="gap-2xs gap-x-md text-ink-2 num flex flex-wrap text-sm">
          <span>
            {article.author ? `By ${article.author}, ` : ""}
            {published === null ? "" : `published ${published}`}
          </span>
          <span className="text-muted">{readingMinutes(article.words)} min read</span>
        </p>

        {/*
         * THE REAL BUTTONS, WORKING, while the body loads.
         *
         * Three versions of this row were wrong before this one, and the
         * sequence is the useful part:
         *
         *   three pulsing bars    a placeholder for something the reader
         *                         already knows the shape of
         *   an empty reserved row kept the layout, gave the reader nothing to
         *                         do for a second
         *   these                 Save and Mark read are the two things a
         *                         reader does to an article WITHOUT reading
         *                         it, so making them wait for the body to
         *                         arrive is making them wait for nothing.
         *
         * SAFE BECAUSE THE SERVER IS THE GATE, not this component.
         * `toggleSaved` and `toggleRead` call `assertCan` and filter every
         * query by `user_id`, so a press here is authorized exactly as one in
         * the loaded pane is. My earlier note claiming otherwise is corrected
         * in `article-list/index.tsx`.
         *
         * ONE HONEST CAVEAT: a press in this window is optimistic in a
         * component that is about to be replaced. The navigation's payload was
         * requested BEFORE the press, so it can arrive carrying the old
         * `saved`/`read` and flip the button back for a moment; the action's
         * own `revalidatePath` then settles it. The write is never lost — only
         * its echo is briefly stale.
         */}
        <div className="gap-xs pb-md border-rule flex flex-wrap border-b">
          {/* Keyed like the pane's own copy, so switching rows mid-flight
              drops the previous article's optimistic guess. */}
          <ArticleActions
            key={article.id}
            articleId={article.id}
            saved={article.saved}
            read={article.read}
          />
          {/* Omitted, not disabled, when the feed gave the item no address —
              the loaded pane has the same gap for the same reason. */}
          {article.url !== null && (
            <Button asChild variant="outline" size="sm">
              <a href={article.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                Open original
              </a>
            </Button>
          )}
        </div>

        {/*
         * The body, which is the only part genuinely being waited for. Three
         * paragraphs, the same shape `ReaderPaneSkeleton` uses, so the two
         * states are recognisably the same pane in different stages.
         */}
        {[
          ["100%", "96%", "99%", "93%", "61%"],
          ["100%", "94%", "98%", "48%"],
          ["100%", "97%", "72%"],
        ].map((lines, p) => (
          <div key={p} className="gap-2xs grid" aria-hidden="true">
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
