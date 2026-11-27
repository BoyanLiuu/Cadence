"use client";

import { useEffect, useState } from "react";

import { type OpeningArticle, ReaderPaneOpening } from "./opening";
import { ReaderPaneSkeleton } from "./skeleton";

/*
 * Shows the skeleton the moment a row is clicked, not when the server answers.
 *
 * ---------------------------------------------------------------------------
 * WHY A CLIENT COMPONENT AND NOT A `<Suspense>` BOUNDARY
 * ---------------------------------------------------------------------------
 * The obvious fix — a `<Suspense key={openId}>` around the pane — is in
 * `reader-view.tsx` and it DOES NOT FIRE HERE, which is worth stating plainly
 * because the opposite was written in a comment in this project and believed.
 *
 * MEASURED, in a browser, with a `MutationObserver` recording every change:
 *
 *   /reader -> /feed/1   a ROUTE change        skeletons at 86-133 ms  ✓
 *   ?folder=2            a SEARCH PARAM        no skeleton at all, 926 ms
 *   ?article=114         a SEARCH PARAM        no skeleton at all, 1074 ms
 *
 * React will not replace content that is already on screen with a fallback
 * during a transition, and Next wraps a search-param navigation in one. A new
 * `key` remounts the boundary but does not buy an exception: React still waits
 * for the content rather than showing the reader a placeholder where a
 * finished article used to be. That is usually the right instinct — it is what
 * stops a page flashing — and here it produces the exact bug it is trying to
 * avoid, because the content it holds on screen is the WRONG ARTICLE. A reader
 * clicks, sees the previous piece for a second, and clicks again.
 *
 * So the pending state has to be owned by the client, where the click is.
 *
 * ---------------------------------------------------------------------------
 * HOW IT KNOWS
 * ---------------------------------------------------------------------------
 * A document-level listener on the rows, found by `data-article-id` — the same
 * seam `mark-read-on-scroll.tsx` uses, and for the same stated reason: the list
 * is a Server Component holding real rows, and lifting it into the client to
 * share a boolean would mean serialising every row, re-implementing the five
 * empty states and losing the server-rendered first paint. The alternative was
 * a context provider wrapping both panes plus a client wrapper per row, which
 * is more moving parts for the same signal.
 *
 * `useLinkStatus()` is the Next-native answer and does not reach: it reports
 * the pending state of the link it is INSIDE, so it can dim the row that was
 * clicked, but the pane is a sibling in a different subtree and cannot read it.
 *
 * IT CLEARS ON THE ARTICLE ID, not on a timer. The id is the server's answer
 * arriving — when `articleId` becomes the one that was clicked, the real pane
 * is on screen and there is nothing left to wait for. A timeout would be
 * guessing at how slow a publisher's round trip is.
 */
export function PaneSwap({
  /** The article the server has actually rendered, or null for none. */
  articleId,
  children,
}: {
  articleId: number | null;
  children: React.ReactNode;
}) {
  const [pendingFor, setPendingFor] = useState<number | null>(null);
  /*
   * What the clicked row already told us about the article. `null` when the
   * pane was reached some other way — a reload, a link, the saved shelf — and
   * there is nothing to go on but the plain skeleton.
   */
  const [known, setKnown] = useState<OpeningArticle | null>(null);

  /*
   * CLEARED WHENEVER THE RENDERED ARTICLE CHANGES, which covers more than the
   * happy path: the clicked article arriving, a DIFFERENT article arriving
   * because the reader clicked twice, and the pane closing. All three mean the
   * server has answered and this component's guess is no longer the truth.
   *
   * ADJUSTED DURING RENDER, not in an effect. React's own guidance for
   * resetting state when a prop changes, and the reason is visible here: in an
   * effect this renders the stale skeleton once, commits it, then clears and
   * renders again — a paint of the placeholder AFTER the real article was
   * ready. Done this way React re-runs this component before committing
   * anything, so the article appears in one frame. (It is also what
   * `react-hooks/set-state-in-effect` is there to catch.)
   */
  const [renderedFor, setRenderedFor] = useState(articleId);
  if (renderedFor !== articleId) {
    setRenderedFor(articleId);
    setPendingFor(null);
  }

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      /*
       * A PLAIN LEFT CLICK ONLY. Cmd-click, middle-click and shift-click open
       * a new tab or window — this pane is not going anywhere, and showing it
       * a skeleton would leave one on screen until something else cleared it.
       */
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (event.defaultPrevented) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      // Inside a row, and on the row's link rather than on a button in it
      // (Save and Mark read live in rows on some screens and navigate nowhere).
      const row = target.closest("[data-article-id]");
      if (row === null || target.closest("a") === null) return;

      const id = Number(row.getAttribute("data-article-id"));
      // The row already open navigates nowhere worth waiting for.
      if (!Number.isSafeInteger(id) || id === articleId) return;

      /*
       * THE ROW'S OWN FACTS, so the pane can be headed by the headline that
       * was just clicked instead of a grey bar over it. Carried as `data-*`
       * by `article-list/index.tsx` — see the note there on why these are
       * attributes rather than the elements' rendered text.
       *
       * A row missing them still works: `known` falls back to null and the
       * plain skeleton shows, which is what any other entry point into the
       * pane gets.
       */
      const title = row.getAttribute("data-title");
      const feedTitle = row.getAttribute("data-feed-title");
      const publishedAt = row.getAttribute("data-published-at");
      const words = Number(row.getAttribute("data-words"));
      const author = row.getAttribute("data-author");
      const url = row.getAttribute("data-url");

      setPendingFor(id);
      setKnown(
        title !== null && feedTitle !== null && publishedAt !== null
          ? {
              id,
              title,
              feedTitle,
              publishedAt,
              author: author === null || author === "" ? null : author,
              words: Number.isFinite(words) ? words : 0,
              url,
              read: row.getAttribute("data-read") === "true",
              saved: row.getAttribute("data-saved") === "true",
            }
          : null,
      );
    };

    /*
     * CAPTURE, so this runs before the router's own handler begins the
     * navigation — the whole point is to paint in the same frame as the click.
     */
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [articleId]);

  if (pendingFor !== null && pendingFor !== articleId) {
    /*
     * The row's facts when we have them, bars when we do not. The second case
     * is not a lesser fallback for the same event — it is a DIFFERENT event: a
     * pane reached without a click to read anything off.
     */
    return known === null ? <ReaderPaneSkeleton /> : <ReaderPaneOpening article={known} />;
  }
  return children;
}
