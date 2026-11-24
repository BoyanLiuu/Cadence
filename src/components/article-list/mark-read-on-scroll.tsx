"use client";

import { useEffect, useRef } from "react";

/*
 * Mark-read-on-scroll (ARCHITECTURE §6.2, Appendix F).
 *
 * "Optimistic in the client and flushed", with rows dimming in 150 ms and NO
 * LAYOUT SHIFT — the reader is scrolling, and anything that moves layout under
 * a thumb loses their place. A marked row dims where it is; it never collapses.
 * ("Mark all read" is the behaviour that removes rows, deliberately a separate
 * one.)
 *
 * IT DRIVES THE DOM RATHER THAN OWNING THE ROWS, which is why this is a small
 * component and not a rewrite of the list. The article list is a Server
 * Component holding real `Article` rows; lifting it into the client to hold
 * optimistic state would mean serialising every row, re-implementing the five
 * empty states and losing the server-rendered first paint. Instead each row
 * carries `data-article-id` and `data-dimmed`, the server sets it from
 * the database, this sets it optimistically, and ONE selector styles both.
 *
 * WHAT COUNTS AS READ: the row's bottom has passed the top of the viewport —
 * scrolled past, not merely seen. Two near-misses are worth naming because both
 * mark a whole list read without anyone scrolling:
 *
 *   `!isIntersecting` alone is true for every row BELOW the fold on first
 *   paint. The check is `boundingClientRect.bottom <= 0`, which means it left
 *   via the top.
 *
 *   A row ALREADY above the viewport when this mounts is not observed at all.
 *   Browsers restore scroll position on reload and on back-navigation, so the
 *   observer's first callback would otherwise report a screenful of rows as
 *   scrolled past that this session never touched.
 */

/** The batching window. Appendix F: flushed every 2 s. */
const FLUSH_MS = 2_000;

/** The route's own cap, so a flush is never refused for being too large. */
const MAX_BATCH = 500;

/**
 * Whether a failed flush is worth repeating.
 *
 * TRANSIENT ONLY. A 401 (session expired) or 501 (fixtures mode, no database)
 * will fail identically forever, and retrying them grows `pending` without
 * bound while every later flush re-sends the whole accumulated set. The
 * optimistic dim is rolled back in that case, because a row that looks read and
 * was never recorded is the one outcome worse than not marking it.
 */
const worthRetrying = (status: number) => status === 429 || status >= 500;

export function MarkReadOnScroll({ enabled }: { enabled: boolean }) {
  /*
   * Ids seen but not yet sent, and the rows they came from so a dim can be
   * undone. Refs, not state: nothing here renders, and state would re-run the
   * effect on every scroll.
   */
  const pending = useRef<Map<number, HTMLElement>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set when the server has refused in a way repeating cannot fix. */
  const givenUp = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    // A browser without IntersectionObserver keeps the server's read state and
    // loses only the automatic marking, which is the right way to degrade.
    if (typeof IntersectionObserver === "undefined") return;

    let unmounted = false;

    const undim = (rows: Iterable<HTMLElement>) => {
      for (const row of rows) row.dataset.dimmed = "false";
    };

    const flush = (final = false) => {
      timer.current = null;
      if (givenUp.current) return;

      const batch = [...pending.current.entries()].slice(0, MAX_BATCH);
      if (batch.length === 0) return;
      for (const [id] of batch) pending.current.delete(id);

      const ids = batch.map(([id]) => id);
      const rows = batch.map(([, row]) => row);

      /*
       * `keepalive`, so a flush started as the tab closes still goes. Without
       * it the last screenful of a reading session is silently lost — the
       * commonest moment for this to matter and the hardest to notice.
       */
      void fetch("/api/read-state", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, read: true }),
        keepalive: true,
      })
        .then((response) => {
          if (response.ok) return;

          if (!worthRetrying(response.status)) {
            // Nothing here will work later. Stop, and stop lying about it.
            givenUp.current = true;
            undim(rows);
            undim(pending.current.values());
            pending.current.clear();
            return;
          }
          requeue(ids, rows, final);
        })
        .catch(() => {
          // A network error IS transient — offline, a dropped connection.
          requeue(ids, rows, final);
        });
    };

    /*
     * RE-QUEUE AND RESCHEDULE. The first version put the ids back and never
     * set a new timer, so they left only if another row happened to scroll
     * past — which, at the end of a reading session, nothing does. The write is
     * idempotent (§6.2), so a retry cannot double-count or move a timestamp.
     */
    const requeue = (ids: number[], rows: HTMLElement[], final: boolean) => {
      if (final || unmounted) {
        // Nothing will run after unmount, so a retry would be a promise to
        // nobody. Undim instead: better an unmarked row than a false one.
        undim(rows);
        return;
      }
      ids.forEach((id, i) => pending.current.set(id, rows[i]!));
      schedule();
    };

    const schedule = () => {
      if (timer.current === null && !givenUp.current) {
        timer.current = setTimeout(() => flush(), FLUSH_MS);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (entry.isIntersecting || entry.boundingClientRect.bottom > 0) continue;

          const id = Number(row.dataset.articleId);
          if (!Number.isSafeInteger(id) || id <= 0) continue;

          // The optimistic dim: one attribute, styled by the same selector the
          // server's own `data-dimmed` uses. Open rows are never observed,
          // so this cannot dim the row being read.
          row.dataset.dimmed = "true";
          pending.current.set(id, row);
          observer.unobserve(row);
          schedule();
        }
      },
      // No margin: the threshold is the viewport's own top edge.
      { threshold: 0 },
    );

    /*
     * OBSERVES WHATEVER IS IN THE DOM NOW, AND WHATEVER ARRIVES LATER.
     *
     * The first version queried once at mount, and this component is not
     * remounted by a navigation within `/reader` — so "Older", a scope switch
     * or a search produced fresh `<li>` nodes that nobody watched, and marking
     * silently stopped for the rest of the session. Every row still rendered
     * and nothing threw.
     */
    const watch = (root: ParentNode) => {
      const rows = root.querySelectorAll<HTMLElement>(
        '[data-article-id][data-dimmed="false"]:not([data-open="true"])',
      );
      for (const row of rows) {
        // Already above the viewport when we first see it: this session did not
        // scroll past it, so it is not ours to mark.
        if (row.getBoundingClientRect().bottom <= 0) continue;
        observer.observe(row);
      }
    };

    watch(document);

    const added = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) watch(node.parentNode ?? node);
        }
      }
    });
    added.observe(document.body, { childList: true, subtree: true });

    return () => {
      unmounted = true;
      added.disconnect();
      observer.disconnect();
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // One last attempt — a navigation away mid-window would otherwise drop
      // whatever the timer had not yet sent.
      flush(true);
    };
  }, [enabled]);

  return null;
}
