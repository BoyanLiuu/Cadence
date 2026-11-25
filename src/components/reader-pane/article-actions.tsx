"use client";

import { Bookmark, Square } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { toggleRead, toggleSaved } from "@/app/(reader)/article-actions.action";
import { Button } from "@/components/ui/button";

/*
 * Save and Mark read, for the article in the reading pane.
 *
 * OPTIMISTIC, because both are instant judgements about the thing in front of
 * you: a button that waits for a round trip before admitting it was pressed
 * reads as broken, and these are pressed in sequence while reading. `revalidate`
 * then replaces the server-rendered truth underneath.
 *
 * `useOptimistic` RATHER THAN PLAIN STATE, and that is the part worth knowing.
 * With `useState` the optimistic value would survive the revalidation and win
 * over it — so an action that failed server-side, or a save undone in another
 * tab, would leave this button lying until a full reload. `useOptimistic`
 * discards its guess when the transition ends, which means the LAST word is
 * always the server's.
 *
 * On failure the message is shown and the button snaps back on its own, for the
 * same reason.
 */

export function ArticleActions({
  articleId,
  saved,
  read,
}: {
  articleId: number;
  saved: boolean;
  read: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [optimisticSaved, guessSaved] = useOptimistic(saved, (_now, next: boolean) => next);
  const [optimisticRead, guessRead] = useOptimistic(read, (_now, next: boolean) => next);

  const run = (guess: () => void, call: () => Promise<{ error: string } | unknown>) => {
    setError(null);
    startTransition(async () => {
      guess();
      try {
        const result = await call();
        if (result !== null && typeof result === "object" && "error" in result) {
          setError(String((result as { error: unknown }).error));
        }
      } catch {
        /*
         * AN ACTION CAN REJECT AS WELL AS RETURN: the POST itself fails when
         * offline or on a 5xx, and then there is no result to inspect. Without
         * this the promise rejected unhandled — the reader saw NO message and
         * the optimistic label just slid back, which looks like the button
         * ignoring them.
         *
         * The third time this project has shipped it: `mark-all-read` carries
         * the same catch and the same comment, which is where it was found
         * first.
         */
        setError("Could not reach the server. Nothing changed.");
      }
    });
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        aria-pressed={optimisticSaved}
        onClick={() =>
          run(
            () => guessSaved(!optimisticSaved),
            () => toggleSaved(articleId, !optimisticSaved),
          )
        }
      >
        <Bookmark aria-hidden="true" />
        {optimisticSaved ? "Saved" : "Save"}
      </Button>

      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          run(
            () => guessRead(!optimisticRead),
            () => toggleRead(articleId, !optimisticRead),
          )
        }
      >
        <Square aria-hidden="true" />
        {optimisticRead ? "Mark unread" : "Mark read"}
      </Button>

      {error !== null && (
        <p role="alert" className="text-error basis-full text-sm">
          {error}
        </p>
      )}
    </>
  );
}
