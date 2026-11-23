/*
 * Paths that more than one surface has to agree on.
 *
 * `READER_PATH` exists because moving the reader off `/` meant changing it in
 * six places — the app bar's wordmark and its Reader tab, the sidebar's "all
 * unread" and per-folder links, the saved screen's back link and its article
 * links — and a seventh, the sign-in redirect, lives in the environment.
 *
 * Two of the six are `pathWith(READER_PATH, …)` calls, which look identical to
 * the one that builds `/feed/:id`: miss one and the link still resolves, still
 * renders, and silently drops the reader's scope. The other four are plain
 * hrefs, where a miss lands on the public home page instead.
 */

/** The three-pane reader. `/` is the public home page from M11 onward. */
export const READER_PATH = "/reader";
