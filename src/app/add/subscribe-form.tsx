"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import type { SubscribeState, subscribeToFeed } from "./subscribe.action";

/*
 * The form around `/add`'s subscribe controls.
 *
 * A CLIENT COMPONENT THAT OWNS ONLY THE FORM. Everything inside it — the
 * candidate cards, the preview, the folder select — is still rendered on the
 * server and passed through as `children`, so none of it is serialised into the
 * bundle or re-implemented here. What needs the client is exactly two things:
 * `useActionState`, to show the message the action returns instead of throwing
 * it away, and the pending flag so the button cannot be pressed twice.
 *
 * `<form action={…}>` means this works with NO JavaScript as well: the browser
 * posts the form and the server redirects. The only thing lost without JS is
 * the inline error, which arrives as a full page render instead.
 */

export function SubscribeForm({
  action,
  children,
}: {
  action: typeof subscribeToFeed;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<SubscribeState, FormData>(action, null);

  return (
    <form action={formAction} className="gap-lg grid">
      {children}

      {/* The accent is reserved for the one committing action on the page
          (Appendix E), which is why nothing else here is orange. */}
      <Button
        type="submit"
        disabled={pending}
        className="bg-accent text-accent-ink hover:bg-accent-hover justify-self-start"
      >
        {pending ? "Following…" : "Subscribe"}
      </Button>

      {state !== null && (
        /*
         * `role="alert"`, not a toast: the reader is mid-task with the form
         * still on screen, and the two real failures — an address that is not
         * one, a folder that is not theirs — are things to fix here rather than
         * notices to dismiss.
         */
        <p
          role="alert"
          className="border-error bg-paper-hi text-ink px-sm py-xs max-w-[46rem] border text-sm"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}
