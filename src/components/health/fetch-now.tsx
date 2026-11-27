"use client";

import { useState, useTransition } from "react";

import { fetchNow } from "@/app/settings/feeds/fetch-now.action";
import { Button } from "@/components/ui/button";
import type { FetchNowResult } from "@/lib/types";

/*
 * "Fetch now", one per row of the health table.
 *
 * WHY IT IS ON EVERY ROW AND NOT ONCE ON THE PAGE. A page-level "check
 * everything" is the cron's job and this screen already reports it. What a
 * reader actually wants is this feed: the one they just followed, or the one
 * showing "Stopped" that they think the publisher has fixed. A single button
 * that polled all of them would send requests to twenty publishers to answer a
 * question about one.
 *
 * IT SAYS WHAT HAPPENED, which is the whole point of the button on a screen
 * whose subject is evidence. "Checked" would leave a reader exactly where they
 * were — the five outcomes (§6.4 names four of them) are different facts, and
 * "Nothing new" is a SUCCESS that looks like nothing happening unless it is
 * said out loud. The row's own numbers update underneath from the revalidation,
 * so the sentence and the table agree.
 */

/** The outcome in the row's own words. `null` for nothing yet. */
function sentenceFor(result: FetchNowResult): { text: string; warn: boolean } {
  switch (result.kind) {
    case "changed":
      return {
        text:
          result.itemsNew === 0
            ? // A 200 whose items the ladder had all seen before: the feed
              // answered and changed, and nothing in it was new to this reader.
              "Read it; nothing new in it"
            : `${result.itemsNew} new`,
        warn: false,
      };
    case "unchanged":
      return { text: "Nothing new", warn: false };
    case "failed":
      // The REASON is in the row's own State and Last check cells, which the
      // revalidation has just refreshed — so repeating it here would print the
      // same fact twice in one row.
      return { text: "It did not answer; see State", warn: true };
    case "busy":
      return { text: "Already being checked", warn: false };
    case "too-soon":
      return { text: `Just checked; try in ${result.waitS} s`, warn: false };
  }
}

export function FetchNow({ feedId, feedTitle }: { feedId: number; feedTitle: string }) {
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<{ text: string; warn: boolean } | null>(null);

  return (
    <div className="gap-3xs grid justify-items-start">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        /*
         * NAMES THE FEED, because the visible label does not. Nine of these on
         * a page all read "Fetch now" to a screen reader, and the table header
         * association is not enough to tell them apart out of context.
         *
         * THE VISIBLE TEXT STAYS AT THE FRONT, which is not a style choice:
         * `aria-label` REPLACES the accessible name, and voice control matches
         * what it can see. "Fetch Hacker News now" no longer contains "Fetch
         * now", so saying "click Fetch now" would match nothing (WCAG 2.5.3,
         * label in name). The colon form keeps the spoken label a prefix of
         * itself.
         */
        aria-label={`Fetch now: ${feedTitle}`}
        onClick={() => {
          setSaid(null);
          startTransition(async () => {
            try {
              const state = await fetchNow(feedId);
              setSaid(
                "error" in state ? { text: state.error, warn: true } : sentenceFor(state.result),
              );
            } catch {
              /*
               * An action can REJECT as well as return — the POST itself fails
               * offline or on a 5xx, and then there is no value to read. The
               * sixth place in this project that has needed this handler;
               * without it the promise rejects unhandled and the button simply
               * stops saying "Checking…".
               */
              setSaid({ text: "Could not reach the server", warn: true });
            }
          });
        }}
      >
        {pending ? "Checking…" : "Fetch now"}
      </Button>

      {said !== null && (
        /*
         * `role="status"`, so the answer is announced rather than only drawn.
         * The button's own label goes back to "Fetch now" when the transition
         * ends, which on its own tells a reader who cannot see this nothing at
         * all about what the fetch found.
         */
        <p
          role="status"
          className={`num max-w-[18ch] text-xs ${said.warn ? "text-error" : "text-muted"}`}
        >
          {said.text}
        </p>
      )}
    </div>
  );
}
