"use server";

import { messageForActionError } from "@/lib/server/action-error";
import { saveArticle, setReadState } from "@/lib/server/mutations";
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
