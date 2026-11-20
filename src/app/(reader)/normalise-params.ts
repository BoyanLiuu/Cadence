import { firstParam, trimmedParam, type ReaderParams } from "@/lib/view-params";

/*
 * The raw search params, normalised once.
 *
 * Extracted from the route component for the same reason the state chooser
 * was: a route component is an async Server Component, so nothing inside it
 * can be rendered by a test — and this function has now been wrong twice.
 *
 *   - It first read `.trim()` off the raw value, which answered 500 to
 *     `?q=a&q=b`, because the router hands over an ARRAY for a repeated key.
 *   - The fix for that listed five of the six keys and omitted `shortcuts`, so
 *     every link built from the result silently dropped it — the exact failure
 *     `view-params.ts` exists to prevent, reintroduced by a fix for something
 *     else.
 *
 * Both were invisible: the page rendered, the links worked, and one parameter
 * quietly stopped existing.
 */

/** What the router may hand over: each key present, absent, or repeated. */
export type RawReaderParams = {
  [K in keyof ReaderParams]?: string | string[];
};

export function normaliseParams(raw: RawReaderParams): ReaderParams {
  // Trimmed once, here, and an empty result treated as absent. Keeping the raw
  // value meant `/?q=%20%20` rendered no search while emitting `q=++` into
  // every link on the page.
  const q = trimmedParam(raw.q);

  return {
    scope: firstParam(raw.scope),
    folder: firstParam(raw.folder),
    q: q === "" ? undefined : q,
    before: firstParam(raw.before),
    article: firstParam(raw.article),
    shortcuts: firstParam(raw.shortcuts),
  };
}
