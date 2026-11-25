"use server";

import { messageForActionError } from "@/lib/server/action-error";
import { extractArticle, saveArticle, setReadState } from "@/lib/server/mutations";
import { revalidateQuietly } from "@/lib/server/revalidate";
import { getViewer } from "@/lib/server/viewer";

/*
 * The reader pane's two buttons: Save, and Mark read / Mark unread.
 *
 * ACTIONS, because a person pressed them — the rule this project settled at
 * M11. The read-state ROUTE exists for the opposite case: the scroll observer's
 * background flush, which needs plain HTTP it can retry with `keepalive` as the
 * tab closes. Both end at the same mutations; only the transport differs, and
 * it differs because the trigger does.
 *
 * MARKING ONE ARTICLE READ GOES THROUGH THE BATCH MUTATION, with a batch of
 * one. That is not a workaround: `setReadState` already answers "which of these
 * may this reader touch" and keeps `read_at` idempotent, and a second path to
 * the same column would be a second place for those to be true.
 *
 * Both return their new state so the caller can render it without a round trip,
 * and both revalidate — unlike the resurface setting, these DO change what the
 * reader sees: the sidebar's counts, the unread list, the saved shelf.
 */

export type ArticleActionState = { error: string } | { saved: boolean } | { read: boolean } | null;

export type ExtractState = { error: string } | { status: string };

export async function toggleSaved(articleId: number, saved: boolean): Promise<ArticleActionState> {
  try {
    const viewer = await getViewer();
    await saveArticle(viewer, articleId, saved);
  } catch (error) {
    return { error: messageForActionError(error, "Could not save that.") };
  }

  // `/saved` is its own surface (§2), so it is the one that most needs this.
  revalidateQuietly("/reader", "layout");
  revalidateQuietly("/saved");
  return { saved };
}

export async function toggleRead(articleId: number, read: boolean): Promise<ArticleActionState> {
  try {
    const viewer = await getViewer();

    const result = await setReadState(viewer, [articleId], read);
    /*
     * `applied: 0` means the id was not this reader's — `setReadState` reports
     * that rather than throwing, because a batch must not fail over one stale
     * id. With a batch of ONE there is nothing else it could have done, so the
     * silence has to be turned back into an error or the button would claim
     * success for a write that did not happen.
     */
    if (result.applied === 0) return { error: "That article is not in any feed you follow." };
  } catch (error) {
    return { error: messageForActionError(error, "Could not change that.") };
  }

  revalidateQuietly("/reader", "layout");
  return { read };
}

/**
 * Reads the full text off the article's page, on open (§6.5).
 *
 * AN ACTION, NOT A ROUTE, by the same rule as the buttons above: a person
 * opened an article. The route ARCHITECTURE's table names
 * (`POST /api/articles/:id/extract`) has no machine caller — nothing polls
 * this, nothing retries it in the background — so there is nothing for a route
 * to be for. Recorded as documentation debt in `decisions.md`, alongside
 * subscribe and mark-all-read.
 *
 * CALLED FROM THE CLIENT ON MOUNT rather than during the page's render, and
 * that is forced rather than chosen: this WRITES, and a Server Component
 * render may not. "On open" therefore means "when the pane has mounted for an
 * article that needs it", which is the honest reading of §6.5 and also the one
 * that keeps the page's first paint off a publisher's response time.
 *
 * `revalidateQuietly` IS THE DELIVERY MECHANISM. It refreshes this route, the
 * server re-reads the article, and `db/map.ts` prefers the stored extraction —
 * so the text appears in the body the server rendered. Returning the HTML from
 * here as well put the whole article on screen twice.
 */
export async function extractFullText(articleId: number): Promise<ExtractState> {
  let result;
  try {
    const viewer = await getViewer();
    result = await extractArticle(viewer, articleId);
  } catch (error) {
    return { error: messageForActionError(error, "Could not read the full text.") };
  }

  /*
   * THE REVALIDATION IS HOW THE READER GETS THE TEXT, not the return value.
   * It refreshes this route, the server re-reads the article, and `bodyOf`
   * prefers the stored extraction — so returning the HTML as well drew the
   * whole article a second time. Only the status comes back, for the caller to
   * say whether anything is still in flight.
   */
  revalidateQuietly("/reader", "layout");
  return { status: result.status };
}
