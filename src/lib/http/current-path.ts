/**
 * The header carrying the path of the request being served.
 *
 * A Server Component has no access to its own pathname — there is no API for
 * it — so `requireViewer()` cannot build a `redirect_url` without help. The
 * middleware is the one place that does see the URL, so it sets this and the
 * viewer reads it.
 *
 * IN ITS OWN MODULE, which is not fussiness: the constant started out exported
 * from `src/proxy.ts`, and importing it from there pulled that file's
 * `clerkMiddleware(...)` call — evaluated at module scope — into the graph of
 * everything that needed the name. Four unit tests died on it before the
 * module had finished loading.
 *
 * Shared rather than spelled twice, because a typo on one side is a redirect
 * that silently forgets where the reader was going.
 */
export const CURRENT_PATH_HEADER = "x-current-path";
