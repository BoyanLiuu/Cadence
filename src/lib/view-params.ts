/*
 * Building reader links that keep the rest of the view.
 *
 * A bare `href="?article=12"` replaces the WHOLE query string. Every link in
 * the reader was written that way, and every one of them silently dropped the
 * rest of the view: opening an article from "All articles" landed back in "All
 * unread", where that article is not listed, so the row the reader clicked
 * appeared to vanish. The Older link did worse — it applied a keyset cursor
 * taken from one result set to a different one, making every read article
 * older than the cursor unreachable.
 *
 * So links are built by MERGING into the current parameters, never by replacing
 * them. The rule that makes this safe is at the bottom: anything that changes
 * which rows are in the list must drop the cursor.
 */

export type ReaderParams = {
  before?: string;
  scope?: string;
  q?: string;
  article?: string;
  folder?: string;
  /** Opens the keyboard-shortcuts dialog. The dialog itself arrives at M14. */
  shortcuts?: string;
};

/** A key whose value should be removed rather than set. */
const DROP = null;

type Patch = Partial<Record<keyof ReaderParams, string | null>>;

/**
 * `?a=1&b=2` built from the current params plus a patch.
 *
 * Keys are emitted in a fixed order so two equivalent links are the same
 * string — which keeps `aria-current` comparisons and Next's prefetch cache
 * predictable.
 */
export function hrefWith(current: ReaderParams, patch: Patch): string {
  const merged: ReaderParams = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof ReaderParams, string | null][]) {
    if (value === DROP) delete merged[key];
    else merged[key] = value;
  }

  const order: (keyof ReaderParams)[] = ["scope", "folder", "q", "before", "article", "shortcuts"];
  const search = new URLSearchParams();
  for (const key of order) {
    const value = merged[key];
    if (value !== undefined && value !== "") search.set(key, value);
  }

  const query = search.toString();
  return query === "" ? "?" : `?${query}`;
}

/**
 * A link that changes WHICH ROWS the list contains.
 *
 * Drops `before`, because a keyset cursor is only meaningful for the exact
 * result set it was taken from. Carrying it across a scope or search change
 * points it at rows that may not exist, which reads to the reader as a page of
 * articles going missing. Also drops `article`, since the open article may not
 * be in the new set.
 */
export function hrefForNewResultSet(current: ReaderParams, patch: Patch): string {
  return hrefWith(current, { ...patch, before: DROP, article: DROP });
}

/** A path link — a feed or folder — carrying the view's shape but not its page. */
export function pathWith(path: string, current: ReaderParams, patch: Patch = {}): string {
  const query = hrefForNewResultSet({ scope: current.scope, q: current.q }, patch);
  return query === "?" ? path : `${path}${query}`;
}

/**
 * A URL path or query segment parsed as a strict positive integer.
 *
 * `Number.parseInt` is the wrong tool here: it stops at the first
 * non-digit, so `12abc`, `0012` and `12.9` all became 12. That gave one feed
 * unlimited distinct URLs — and a row whose own href is `?article=101` was not
 * highlighted when the page was reached via `?article=101abc`, because the two
 * strings differ while the ids match.
 *
 * Returns null for anything that is not exactly a canonical integer.
 */
export function strictId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The first value of a query parameter, whatever shape the router handed over.
 *
 * Next gives a STRING for `?q=a` and an ARRAY for `?q=a&q=b`, and nothing stops
 * a visitor sending the second form. Every route that called `.trim()` on the
 * value answered 500 to `?q=a&q=b` — including `/add`, whose own discovery
 * validation was hardened for exactly this and then bypassed by the caller
 * doing the trimming first.
 *
 * Taking the first value is the standard reading and the one a reader means:
 * a repeated parameter is almost always a doubled link, not a request for both.
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** `firstParam`, trimmed, with an empty string reported as absent. */
export function trimmedParam(value: string | string[] | undefined): string {
  return firstParam(value)?.trim() ?? "";
}
