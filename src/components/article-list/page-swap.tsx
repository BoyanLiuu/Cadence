"use client";

import { useEffect, useState } from "react";

import { ArticleRowsSkeleton } from "./skeleton";

/*
 * Shows skeleton rows the moment a page number is clicked.
 *
 * WHY THE `<Suspense>` UPSTREAM DOES NOT COVER THIS. `?page=2` is a
 * search-param navigation, and React will not replace content that is already
 * on screen with a fallback during a transition — measured in a browser and
 * written up in `reader-view.tsx`. The boundary's key does change, and the
 * fallback still never appears: the reader clicks "2" and page 1's rows sit
 * there, looking like a click that did not register, for as long as the server
 * takes. (That was ~1800 ms before the list stopped waiting on the sidebar's
 * aggregates, and is ~500-1000 ms now. Still long enough to click twice.)
 *
 * So, like `reader-pane/pane-swap.tsx`, the pending state is owned by the
 * client, where the click is.
 *
 * THE ROWS ONLY — not the header and NOT the pager. The heading, the
 * Unread/All toggle, the search field and the page buttons are all still true
 * while the next page loads, and blanking the pager would take away the
 * control the reader just used and is likely to use again. Only the thing that
 * is actually changing is replaced.
 *
 * FOUND BY `data-page-link`, not by the nav's accessible name. A selector tied
 * to `aria-label="Pages"` would break silently the day that label is reworded,
 * and the failure would be this component quietly doing nothing.
 */
export function PageSwap({
  /** The page the server actually rendered. */
  page,
  children,
}: {
  page: number;
  children: React.ReactNode;
}) {
  const [pendingFor, setPendingFor] = useState<number | null>(null);

  /*
   * Cleared whenever the rendered page changes — the server has answered, so
   * this component's guess is no longer the truth. Adjusted during render
   * rather than in an effect: in an effect it paints the stale skeleton once,
   * commits, then clears, which is a flash of placeholder AFTER the rows were
   * ready.
   */
  const [rendered, setRendered] = useState(page);
  if (rendered !== page) {
    setRendered(page);
    setPendingFor(null);
  }

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // A plain left click only: cmd/middle/shift open a new tab, where this
      // pane is not going anywhere and a skeleton would simply be left behind.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (event.defaultPrevented) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("[data-page-link]");
      if (link === null) return;

      const to = Number(link.getAttribute("data-page-link"));
      // The page already shown navigates nowhere worth waiting for.
      if (!Number.isSafeInteger(to) || to === page) return;
      setPendingFor(to);
    };

    // Capture, so this runs before the router begins the navigation — the
    // point is to paint in the same frame as the click.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [page]);

  if (pendingFor !== null && pendingFor !== page) return <ArticleRowsSkeleton />;
  return children;
}
