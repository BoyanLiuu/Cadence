/*
 * The reading pane's two formatters, in a module both sides can import.
 *
 * They were private to `index.tsx`, which is a Server Component — so the
 * client component that paints the pane's header the instant a row is clicked
 * (`pane-swap.tsx`) could not reach them without pulling a server component
 * into the browser bundle. The alternative was a second copy of each, which is
 * how one half of the app starts printing "23 May 2018" while the other prints
 * "May 23, 2018" for the same article.
 *
 * Pure functions over a string and a number, so no `"use client"` is needed:
 * whichever side imports them gets them.
 */

/** "23 May 2018, 13:30" — UTC, because the reader's clock is not the feed's. */
export const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** Roughly 200 words a minute, floored at one. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 200));
