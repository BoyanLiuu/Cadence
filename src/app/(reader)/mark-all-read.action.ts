"use server";

import { markScopeRead } from "@/lib/server/mutations";
import type { ListFilter, Scope } from "@/lib/types";
import { messageForActionError } from "@/lib/server/action-error";
import { revalidateQuietly } from "@/lib/server/revalidate";
import { getViewer } from "@/lib/server/viewer";

/*
 * The project's FIRST server action, so the shape here is a precedent.
 *
 * WHY AN ACTION AND NOT A ROUTE. `PATCH /api/read-state` exists because a
 * background flush needs a plain HTTP call it can retry with `keepalive` while
 * the tab closes. This is the opposite: a button the reader pressed, once, that
 * should leave the page showing the result. An action gets the session, the
 * mutation and `revalidatePath` without inventing an endpoint the prototype
 * never names — and the reader's own click is the CSRF story, since Next ties an
 * action invocation to its own origin.
 *
 * NO `assertCan` HERE, deliberately. The gate lives in `markScopeRead`, where
 * every caller meets it; repeating it in the action would be a second place to
 * forget. This file's only job is to resolve the viewer, hand over, and
 * revalidate.
 *
 * THE SCOPE AND FILTER COME FROM THE CLIENT AND ARE NOT TRUSTED. They say WHICH
 * articles, never WHOSE: `scopedArticleWhere` resolves them against this
 * reader's own subscriptions, so the worst a forged scope can do is name a feed
 * belonging to somebody else and match nothing. A malformed one is refused
 * outright — `markScopeRead` validates the shape, because before it did, `{}`
 * resolved to `where: undefined` and marked a whole corpus read.
 */

export type MarkAllReadResult = { applied: number } | { error: string };

export async function markAllRead(scope: Scope, filter?: ListFilter): Promise<MarkAllReadResult> {
  let result: { applied: number };

  try {
    /*
     * INSIDE THE TRY. It was outside, and `getViewer()` is one of the things
     * here that throws — a revoked session does, by design — which made the
     * action reject rather than return, leaving the button's rows collapsed
     * with nothing said. The whole point of returning errors is lost if the
     * first line can skip it.
     */
    const viewer = await getViewer();
    result = await markScopeRead(viewer, scope, filter);
  } catch (error) {
    /*
     * RETURNED, NOT THROWN. A thrown error in an action reaches the client as
     * an opaque digest in production, so the button could only say "something
     * went wrong". The caller shows this message and puts the rows back.
     */
    return { error: messageForActionError(error, "Could not mark these read") };
  }

  /*
   * The whole reader subtree, not just the current URL: the sidebar's per-feed
   * badges and the header's total come from the same rows, and leaving those
   * stale is how a count the product promises to be trustworthy stops being.
   */
  revalidateQuietly("/reader", "layout");
  return result;
}
