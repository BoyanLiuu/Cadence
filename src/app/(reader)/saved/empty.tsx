import Link from "next/link";

import { READER_PATH } from "@/lib/routes";

import { Button } from "@/components/ui/button";

/*
 * Saved's empty states.
 *
 * Extracted from the page for the same reason M4's state chooser was: the page
 * is an async Server Component, so nothing inside it can be rendered by a test,
 * and copy that is never asserted is copy that drifts.
 *
 * Saved is a different product surface, not a filter on the unread river, and
 * the empty state is where that is cheapest to get wrong. Every clause of the
 * reader's copy — "Nothing unread in any feed. Feeds are checked on their own
 * schedules. The next is Harbour Wire, at 09:52." — is FALSE here: this is not
 * about unread, not about feeds, and not waiting for a schedule. It is waiting
 * for the reader to save something.
 */

const SHELL = "gap-md px-xl py-3xl text-ink-2 grid justify-items-center text-center";

/** Nothing has ever been saved. */
export function SavedEmpty() {
  return (
    <section className={SHELL}>
      <h2 className="font-display text-2xl">Nothing saved yet</h2>
      <p className="max-w-[46ch]">
        Save an article while you are reading it and it waits here — out of the unread count, and in
        no hurry.
      </p>
      <Button asChild variant="outline">
        <Link href={READER_PATH}>Back to the reader</Link>
      </Button>
    </section>
  );
}

/**
 * Things ARE saved, but none match this filter.
 *
 * Deliberately not the state above. "Nothing saved yet" would be false, and a
 * reader who has four saved articles being told they have none would reasonably
 * conclude the app lost them.
 */
export function SavedFilterEmpty({ filter, total }: { filter: "unread" | "read"; total: number }) {
  return (
    <section className={SHELL}>
      <h2 className="font-display text-2xl">Nothing saved is {filter}</h2>
      <p className="max-w-[46ch]">
        {filter === "read"
          ? "You have not finished any of these yet."
          : "You have read everything you saved."}
      </p>
      <Button asChild variant="outline">
        <Link href="/saved">Show all {total}</Link>
      </Button>
    </section>
  );
}
