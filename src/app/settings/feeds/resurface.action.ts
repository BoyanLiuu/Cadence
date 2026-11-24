"use server";

import { updateSubscription } from "@/lib/server/mutations";
import { messageForActionError } from "@/lib/server/action-error";
import { revalidateQuietly } from "@/lib/server/revalidate";
import { getViewer } from "@/lib/server/viewer";

/*
 * "When an article is edited" — the per-subscription hedge on Appendix G's
 * third question.
 *
 * PER SUBSCRIPTION, NOT PER FEED, which is the whole reason this one is safe to
 * wire. Two readers can want different answers about the same feed, and the
 * `feeds` row belongs to all of them — so `resurface_on_revision` lives on
 * `subscriptions` and this action changes nothing anybody else sees. The
 * neighbouring `guidTrustOverride` is the opposite case and is deliberately not
 * forwarded by `updateSubscription`; it writes to the shared row and needs its
 * own decision first.
 *
 * An action rather than the route the Writes table names, consistently with
 * subscribing and mark-all-read: this is a switch a person flipped.
 */

export type ResurfaceState = { error: string } | null;

export async function setResurfaceOnRevision(
  _previous: ResurfaceState,
  form: FormData,
): Promise<ResurfaceState> {
  try {
    const viewer = await getViewer();

    const feedId = Number(form.get("feedId"));
    /*
     * The CURRENT value is submitted and inverted here, rather than the new one
     * being sent. A checkbox posts nothing when unticked, so a form carrying
     * "the value I want" cannot express "off" — it would read as a missing
     * field and leave the setting alone. Submitting what the reader was looking
     * at also means a stale tab cannot silently flip a setting somebody changed
     * elsewhere: it sends what it believed, and the inversion is computed from
     * that.
     */
    const wasOn = form.get("current") === "true";

    await updateSubscription(viewer, feedId, { resurfaceOnRevision: !wasOn });
  } catch (error) {
    return { error: messageForActionError(error, "Could not change that setting.") };
  }

  /*
   * THE FEEDS SUBTREE ONLY. This setting is read at INGEST — `resurfaceRevised`
   * in `lib/ingest/revise.ts` consults it when a poll finds an edited article —
   * and never on a read path, so nothing in the reader renders differently
   * because of it. Purging that subtree too was work for no visible change,
   * with a comment claiming an effect it does not have.
   */
  revalidateQuietly("/settings/feeds", "layout");
  return null;
}
