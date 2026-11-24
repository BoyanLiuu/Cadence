"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { setResurfaceOnRevision, type ResurfaceState } from "./resurface.action";

/*
 * The control for "when an article is edited".
 *
 * A BUTTON THAT SAYS WHAT IT WILL DO, not a checkbox. The two states have
 * paragraphs of their own above it, so a tick box labelled "resurface on
 * revision" would be a third way of saying the same thing and the least clear
 * of them. A button whose label is the OUTCOME — "Bring edited articles back to
 * unread" — reads as the choice rather than as a setting's name.
 *
 * It submits the CURRENT value and the action inverts it, because an unticked
 * checkbox posts nothing and a form carrying "the value I want" therefore
 * cannot express "off". That also means a stale tab sends what it believed and
 * not an absolute, so it cannot silently overwrite a change made elsewhere with
 * a value it never showed anyone.
 *
 * `<form action={…}>` so it works with no client JavaScript; `useActionState`
 * only so the returned message is shown instead of discarded.
 */

export function ResurfaceToggle({ feedId, on }: { feedId: number; on: boolean }) {
  const [state, formAction, pending] = useActionState<ResurfaceState, FormData>(
    setResurfaceOnRevision,
    null,
  );

  return (
    <form action={formAction} className="gap-2xs mt-xs grid justify-items-start">
      <input type="hidden" name="feedId" value={feedId} />
      <input type="hidden" name="current" value={String(on)} />

      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending
          ? "Changing…"
          : on
            ? "Keep read marks when an article is edited"
            : "Bring edited articles back to unread"}
      </Button>

      {state !== null && (
        <p role="alert" className="text-error text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
