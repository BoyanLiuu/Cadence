"use server";

import { messageForActionError } from "@/lib/server/action-error";
import { fetchFeedNow } from "@/lib/server/mutations";
import { revalidateQuietly } from "@/lib/server/revalidate";
import { getViewer } from "@/lib/server/viewer";
import type { FetchNowResult } from "@/lib/types";

/*
 * "Fetch now" — one feed, checked because a reader pressed a button.
 *
 * The limits, the reasoning and the four guards are in `fetchFeedNow`; this is
 * the transport. It exists as a separate file from the page because the page is
 * a Server Component and the button that calls this is a Client one, and a
 * `"use server"` module is what they can share.
 *
 * ONE ARGUMENT, NOT A `FormData`. Nothing here is typed by a person, so there
 * is no form to validate — the feed id comes from the row the button is in. The
 * id is still checked (`Number.isSafeInteger`) and still authorized against
 * this reader's subscriptions in `makeFeedDue`, because a client-supplied
 * number is a client-supplied number however it arrived.
 */

export type FetchNowState = { error: string } | { result: FetchNowResult };

export async function fetchNow(feedId: number): Promise<FetchNowState> {
  let result: FetchNowResult;
  try {
    const viewer = await getViewer();
    result = await fetchFeedNow(viewer, feedId);
  } catch (error) {
    /*
     * `NotSubscribed` and `NoDatabase` both carry sentences meant to be read —
     * "You do not follow this feed." — so they reach the reader as themselves.
     * A stale session redirects instead, from inside `messageForActionError`.
     */
    return { error: messageForActionError(error, "Could not check that feed.") };
  }

  /*
   * OUTSIDE THE `try`, and this project has shipped the other two placements.
   * By the time it runs the poll has happened and `fetch_log` has its row —
   * inside the `try` a cache failure would report a completed check as failed.
   * `revalidateQuietly` swallows and logs; a stale table is a nuisance, and
   * telling a reader nothing happened when a publisher was just fetched is a
   * lie that makes them press again.
   */
  revalidateQuietly("/settings/feeds");
  /* The sidebar's unread counts move when a fetch brings in articles. */
  if (result.kind === "changed" && result.itemsNew > 0) revalidateQuietly("/", "layout");

  return { result };
}
