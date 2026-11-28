"use server";

import { redirect } from "next/navigation";

import { createNewFolder, subscribe, updateSubscription } from "@/lib/server/mutations";
import { messageForActionError } from "@/lib/server/action-error";
import { revalidateQuietly } from "@/lib/server/revalidate";
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
     * "NO FOLDER" ARRIVES TWO WAYS, and neither is a number.
     *
     * `"none"` is what the control sends: Radix treats `value=""` as a cleared
     * selection and refuses it as an item value, so the sentinel is spelled
     * out. `Number("none")` is NaN, which `subscribe` correctly rejects as
     * "not a folder id" — a reader filing a feed under no folder would have
     * been told their folder was invalid.
     *
     * `""` is kept because an ABSENT field reads as the empty string here, and
     * that is now the ordinary case rather than a legacy one: `folder-field.tsx`
     * posts no `folderId` at all when a new folder is being named. (It was also
     * what the native `<select>` on `/add` sent, before both forms moved to the
     * shared control.) `Number("")` is 0, which would name folder zero.
     *
     * Both map to `null`, which is what "no folder" means in the schema.
     */
    const chosenFolderId =
      folderValue === "" || folderValue === "none" ? null : Number(folderValue);

    /*
     * A NEW FOLDER, MADE BEFORE THE SUBSCRIPTION IT IS FOR.
     *
     * `folder-field.tsx` posts `newFolder` only when the reader asked for one,
     * and posts no `folderId` at all in that case — so the two cannot both be
     * meaningful and there is no precedence rule to get wrong. A blank name is
     * treated as "no folder" rather than refused: somebody who opened the
     * field and changed their mind still gets the feed they came for, which is
     * the thing they actually asked for.
     *
     * BEFORE, because the subscription needs its id. The order has a visible
     * consequence worth accepting: a folder created here survives a failure
     * below, so a reader whose feed address turns out to be bad is left with an
     * empty folder. That is recoverable and obvious; creating it afterwards
     * would instead mean a successful subscription filed nowhere, which is
     * silent and looks like the folder choice being ignored.
     *
     * It is IDEMPOTENT BY NAME (`createFolder`), so the empty folder is reused
     * rather than duplicated on the retry that follows.
     */
    const newFolderName = String(form.get("newFolder") ?? "").trim();
    const folderId =
      newFolderName === "" ? chosenFolderId : (await createNewFolder(viewer, newFolderName)).id;

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
    return { error: messageForActionError(error, "Could not follow that feed.") };
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
