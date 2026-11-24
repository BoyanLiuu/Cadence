"use client";

import { useState, useTransition } from "react";

import { markAllRead } from "@/app/(reader)/mark-all-read.action";
import { Button } from "@/components/ui/button";
import type { ListFilter, Scope } from "@/lib/types";

/*
 * "Mark all read" (Appendix F).
 *
 * ROWS COLLAPSE OUT over 200 ms, which is the OPPOSITE of the no-layout-shift
 * rule mark-read-on-scroll follows — and deliberately so. There, the reader is
 * scrolling and the list must hold still under their thumb. Here the reader
 * asked for the list to change, so the rearranging IS the feedback; without
 * exit motion the list jumps and someone working linearly loses their place.
 *
 * IT ANIMATES THE DOM RATHER THAN OWNING THE ROWS, the same choice
 * `mark-read-on-scroll.tsx` makes and for the same reason: the list is a Server
 * Component holding real `Article` rows. `AnimatePresence` would need those
 * rows lifted into client state — serialising every one, re-implementing the
 * five empty states, losing the server-rendered first paint — to animate
 * something that is about to be replaced by a revalidation anyway. The Web
 * Animations API does it on the nodes already there.
 *
 * THE COLLAPSE IS NOT THE SOURCE OF TRUTH. It runs while the action is in
 * flight; `revalidatePath` then re-renders the list from the database, and the
 * animations are released either way. If the action fails the rows come back
 * and say why, because a list that emptied over a server that recorded nothing
 * is the one outcome worse than the button not working.
 */

/** Appendix F's figure. */
const COLLAPSE_MS = 200;

export function MarkAllRead({
  scope,
  filter,
  unreadCount,
}: {
  scope: Scope;
  /*
   * THE SEARCH TERM, and it is not optional detail. Without it the action
   * resolved the UNFILTERED scope: search "rust", see three rows, press the
   * button, and every unread article in the scope was marked read.
   */
  filter?: ListFilter;
  unreadCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const collapse = () => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-article-id]")];
    const animations = rows.map((row) => {
      /*
       * `height` from its measured value to zero, not `display: none`: the
       * animation has to interpolate, and `auto` does not. Measured one row at
       * a time before anything changes, so each keeps its own height.
       */
      const { height } = row.getBoundingClientRect();
      row.style.overflow = "hidden";
      return row.animate(
        [
          { height: `${height}px`, opacity: 1 },
          { height: "0px", opacity: 0 },
        ],
        { duration: COLLAPSE_MS, easing: "ease-in", fill: "forwards" },
      );
    });
    return { rows, animations };
  };

  /*
   * ALWAYS, NOT ONLY ON FAILURE, which is the bug review found.
   *
   * `fill: "forwards"` holds the end state after the animation finishes, and a
   * revalidation re-renders the SAME Server Component tree — React reuses each
   * `<li key={a.id}>`. So in the "All" view, where read articles stay in scope,
   * every row stayed at height 0 while the footer still read "50 articles": a
   * list that looked empty and was not. Cancelling restores the stylesheet's
   * own height, which is correct whether the row survived the revalidation or
   * not; on a row that was removed it is a no-op.
   */
  const release = (rows: HTMLElement[]) => {
    for (const row of rows) {
      row.getAnimations().forEach((animation) => animation.cancel());
      row.style.overflow = "";
    }
  };

  return (
    <div className="gap-2xs grid justify-items-end">
      <Button
        variant="outline"
        size="sm"
        // Nothing to mark, or a mark already in flight. The server would answer
        // `applied: 0` either way; this keeps the reader from asking.
        disabled={unreadCount === 0 || pending}
        onClick={() => {
          setError(null);
          const { rows, animations } = collapse();

          startTransition(async () => {
            try {
              const result = await markAllRead(scope, filter);
              if ("error" in result) setError(result.error);
            } catch {
              /*
               * CAUGHT, because an action can REJECT as well as return: the
               * POST itself can fail offline or on a 5xx, and then there is no
               * result to inspect. Without this the promise rejected
               * unhandled and the rows sat collapsed with nothing said — the
               * outcome this component's own comment calls worse than the
               * button not working.
               */
              setError("Could not reach the server. Nothing was marked.");
            } finally {
              // Let the collapse finish before releasing it, or a fast action
              // snaps the rows back mid-animation.
              await Promise.allSettled(animations.map((a) => a.finished));
              release(rows);
            }
          });
        }}
      >
        {pending ? "Marking…" : "Mark all read"}
      </Button>

      {error !== null && (
        /*
         * SAYS WHAT HAPPENED rather than that something did. The two real cases
         * are a session that expired and fixtures mode with no database, and
         * both are actionable once named.
         */
        <p role="status" className="text-error max-w-[32ch] text-right text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
