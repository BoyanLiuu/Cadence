"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { subscribe, updateSubscription } from "@/lib/server/mutations";
import { getViewer } from "@/lib/server/viewer";

/*
 * Following a feed, from the `/add` form.
 *
 * AN ACTION, NOT THE ROUTE ARCHITECTURE NAMES. Its Writes table lists
 * `POST /api/subscriptions`, and this diverges deliberately and consistently
 * with `mark-all-read`: a route is for something a MACHINE calls — the cron
 * tick with its shared secret, the background read-state flush that needs
 * `keepalive` — and an action is for something a PERSON pressed. An action also
 * ties the invocation to this origin, so there is no CSRF story to write, and a
 * `<form action={…}>` works with no client JavaScript at all. Building both
 * transports for one write would be two things to keep in step. Recorded in the
 * memo rather than left as a silent difference from the doc.
 *
 * THE CUSTOM TITLE IS A SECOND CALL, because the documented arguments to
 * subscribing are `{ feedUrl, folderId? }` and "what I call it in my sidebar"
 * lives on the subscription rather than the request. Two writes where one would
 * do, in exchange for the service layer matching the design it was written
 * against.
 */

/**
 * Revalidation, which must never be able to report the write as failed.
 *
 * It is a CACHE HINT: by the time it runs the rows are written. Inside a `try`
 * its failure became "could not do the thing" for something already done;
 * moved outside, its failure became a REJECTION, which the client reports as
 * "nothing was marked" — a stronger falsehood than before. Review caught the
 * second version, introduced while fixing the first. So it swallows, and says
 * so in the log where a stale sidebar can be traced to it.
 */
function revalidateQuietly(path: string, type?: "layout" | "page") {
  try {
    if (type === undefined) revalidatePath(path);
    else revalidatePath(path, type);
  } catch (error) {
    console.error(`revalidatePath(${path}) failed; a screen may be stale`, error);
  }
}

export type SubscribeState = { error: string } | null;

export async function subscribeToFeed(
  _previous: SubscribeState,
  form: FormData,
): Promise<SubscribeState> {
  let feedId: number;

  try {
    const viewer = await getViewer();

    const feedUrl = String(form.get("feedUrl") ?? "");
    const folderValue = String(form.get("folderId") ?? "");
    const customTitle = String(form.get("customTitle") ?? "").trim();

    /*
     * The select's "No folder" option has an empty value, which is not the same
     * as a missing field and not a number. `Number("")` is 0, which would name
     * folder zero.
     */
    const folderId = folderValue === "" ? null : Number(folderValue);

    const subscription = await subscribe(viewer, { feedUrl, folderId });
    feedId = subscription.feedId;

    /*
     * THE TITLE IS A SEPARATE TRY, because the subscription above is already
     * committed by the time this runs. Inside the same block, a failure here
     * returned "could not follow that feed" for a feed that IS followed — the
     * same invariant this file states two comments down, broken one line
     * earlier.
     *
     * Swallowed rather than reported: the feed is followed, and the documented
     * default for an empty name is "use the feed's own", which is exactly what
     * the reader gets. Renaming is one click away on the feed's own page, and
     * the log records why it is not what they typed.
     */
    if (customTitle !== "") {
      try {
        await updateSubscription(viewer, feedId, { customTitle });
      } catch (error) {
        console.error(`subscribe: naming feed ${feedId} "${customTitle}" failed`, error);
      }
    }
  } catch (error) {
    /*
     * RETURNED, NOT THROWN: a thrown action error reaches the client as an
     * opaque digest in production, and this form's failures are things a reader
     * can act on — a bad address, a folder that is not theirs.
     */
    return { error: error instanceof Error ? error.message : "Could not follow that feed." };
  }

  // The sidebar, the feeds list and the reader all derive from these rows.
  revalidateQuietly("/reader", "layout");
  revalidateQuietly("/settings/feeds");

  /*
   * REDIRECTS TO THE FEED'S OWN PAGE.
   *
   * Not to the reader, because there is nothing to read yet — the feed has only
   * just become due and the first poll has not run. The health page says
   * exactly that, which is the one honest thing to show someone who has just
   * pressed Subscribe.
   */
  redirect(`/settings/feeds/${feedId}`);
}
