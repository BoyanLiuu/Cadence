"use client";

import { useEffect, useRef, useState } from "react";

import { extractFullText } from "@/app/(reader)/article-actions.action";

/*
 * Fetching the full text when an article opens (§6.5).
 *
 * A CLIENT COMPONENT BECAUSE EXTRACTION WRITES. A Server Component render may
 * not perform a write, so "on open" cannot mean "while rendering the page" —
 * it means "once the pane is on screen for an article that needs it". That is
 * also the better behaviour: the first paint shows the feed's teaser
 * immediately instead of waiting on a publisher's response time, and the full
 * text replaces it when it arrives.
 *
 * FIRES ONCE PER MOUNT, GUARDED TWICE. `useEffect` runs twice in development
 * under StrictMode, and React may remount a component for reasons that have
 * nothing to do with the reader — so a bare effect is a second outbound
 * request against a publisher. The ref is checked and set SYNCHRONOUSLY before
 * the await, which is what makes it a lock rather than a hint. The server also
 * refuses a second extraction (`extract_status != 'none'` returns the stored
 * copy and fetches nothing), so this is the second of two guards, not the only
 * one — but the cheap one, and the one that stops the request leaving at all.
 *
 * WHAT IT DOES NOT DO: retry. A `failed` or `blocked` article stays that way
 * until something deliberate changes it, because retrying on every open is
 * repeated unrequested traffic aimed precisely at the hosts least willing to
 * serve it. §6.5's budget is one page load per article a person asked for.
 */

export function FullText({
  articleId,
  /** True when the feed's own body is not the article (§6.5). */
  needed,
  /** Already attempted, whatever the outcome — so nothing is fetched again. */
  attempted,
}: {
  articleId: number;
  needed: boolean;
  attempted: boolean;
}) {
  const [state, setState] = useState<"idle" | "reading" | "done" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!needed || attempted || started.current) return;
    // Set BEFORE the await, so a second effect pass cannot get past it.
    started.current = true;

    let live = true;
    setState("reading");

    void extractFullText(articleId).then(
      (result) => {
        if (!live) return;
        if ("error" in result) {
          setMessage(result.error);
          setState("failed");
          return;
        }
        setState("done");
      },
      () => {
        /*
         * AN ACTION CAN REJECT AS WELL AS RETURN: the POST itself fails when
         * offline or on a 5xx, and then there is no result to read. The fourth
         * place in this project that has needed this exact handler — without
         * it the promise rejects unhandled and the reader sees the spinner
         * stop with no explanation.
         */
        if (!live) return;
        setMessage("Could not reach the server.");
        setState("failed");
      },
    );

    return () => {
      // Stops a resolved request writing state into an unmounted pane, which
      // is what happens when a reader moves to the next article mid-fetch.
      live = false;
    };
  }, [articleId, needed, attempted]);

  if (state === "idle") return null;

  if (state === "reading") {
    return (
      <p className="text-muted px-lg py-md text-sm" role="status">
        Reading the full text from the page…
      </p>
    );
  }

  if (state === "failed") {
    return (
      <p className="text-muted px-lg py-md text-sm" role="status">
        {message ?? "The full text could not be read from the page."} This is what the feed sent.
      </p>
    );
  }

  /*
   * NOTHING. The extracted text arrives through the SERVER, not from here.
   *
   * This component used to render the HTML the action returned, which put the
   * whole article on screen TWICE: `revalidateQuietly` refreshes the route, the
   * server re-reads the article, and `bodyOf` now prefers the stored extraction
   * — so the body above already contains it by the time this would have drawn
   * its own copy.
   *
   * One owner for the article text, and it is the server. This component owns
   * only the fact that a request is in flight and what to say if it failed,
   * which is exactly what a client component is for here.
   */
  return null;
}
