"use client";

import { useEffect, useRef } from "react";

/*
 * Brings the open row into view when the list arrives with one already open.
 *
 * WHY. Opening an article from somewhere else — a row on `/saved`, a link, a
 * reload of a URL carrying `?article=` — renders the list scrolled to the top
 * with the open row wherever it happens to fall. On the saved shelf that is
 * usually off-screen, so the reading pane showed the piece while the list
 * beside it highlighted nothing a reader could see. It reads as the wrong
 * article being open.
 *
 * ONLY ON ARRIVAL, NEVER ON A CLICK IN THE LIST. The rows link with
 * `scroll={false}` precisely so clicking one does not move the list under the
 * pointer — if this ran on every open it would undo that and yank the list on
 * each click. So it fires once per ARTICLE ID: the ref holds the id it last
 * scrolled to, and a click on a row already in view is still a new id, which
 * is why the check below is also against the element's own position.
 *
 * `nearest`, NOT `center`. A row already fully visible must not move at all —
 * `center` would re-centre it and produce exactly the jump this is avoiding.
 * `nearest` is a no-op when the row is on screen.
 *
 * NOT `scrollIntoView` ON THE PAGE. The list is a column in a grid rather than
 * its own scroll container, so the element's `scrollIntoView` would move the
 * whole document and take the reading pane's position with it. `block:
 * "nearest"` keeps that to the minimum needed, and reduced motion is honoured
 * by asking for `auto` rather than `smooth` when the reader has asked for it.
 */
export function ScrollOpenIntoView({ articleId }: { articleId: number | null }) {
  const scrolledTo = useRef<number | null>(null);

  useEffect(() => {
    if (articleId === null) return;
    if (scrolledTo.current === articleId) return;
    scrolledTo.current = articleId;

    const row = document.querySelector(`[data-article-id="${articleId}"]`);
    if (!(row instanceof HTMLElement)) return;

    /*
     * ALREADY VISIBLE IS LEFT ALONE. `nearest` is close to a no-op for a row
     * on screen, but "close to" still produces a pixel or two of movement in
     * some browsers — and the common case is a click on a row the reader is
     * looking at.
     */
    const box = row.getBoundingClientRect();
    const fullyVisible = box.top >= 0 && box.bottom <= window.innerHeight;
    if (fullyVisible) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [articleId]);

  return null;
}
