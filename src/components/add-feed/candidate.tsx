import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { effectiveIntervalSeconds } from "@/lib/schedule/interval";
import type { Candidate, DiscoveryResult } from "@/lib/types";

/*
 * What a discovered feed looks like, shared by the `/add` page and the dialog.
 *
 * EXTRACTED RATHER THAN COPIED, because this is the screen that states the
 * facts a reader decides on — format, item count, last post, the cadence they
 * will actually get — and two copies would drift. The page and the dialog
 * already disagree on how SELECTION works, which is the one thing that is
 * genuinely different between them: on the page it is the URL, so a choice is
 * shareable and survives a reload; in the dialog it is component state,
 * because a modal has no address of its own.
 *
 * SO THE CARD'S BODY IS SHARED AND ITS WRAPPER IS NOT. `CandidateBody` renders
 * everything inside; the page wraps it in a `<Link>` and the dialog in a
 * `<button>`. That keeps the facts in one place without pretending the two
 * interactions are the same.
 */

/** `null` for a date that is not one, rather than the string "Invalid Date". */
export const shortDate = (iso: string): string | null => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

export const FORMAT_NAME: Record<Candidate["format"], string> = {
  rss2: "RSS 2.0",
  rss1: "RSS 1.0 (RDF)",
  atom: "Atom",
  json: "JSON Feed",
  unknown: "Unknown",
};

/** "about every 24 h" — the interval in the words the screen uses. */
export function everyPhrase(seconds: number): string {
  if (seconds >= 86400) return `about every ${Math.round(seconds / 86400) * 24} h`;
  if (seconds >= 3600) return `about every ${Math.round(seconds / 3600)} h`;
  return `about every ${Math.round(seconds / 60)} min`;
}

/** The radio's look without its behaviour; selection is the caller's business. */
export function SelectionDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`border-ink mt-1.5 grid size-4 place-items-center rounded-full border ${
        checked ? "" : "border-muted"
      }`}
    >
      {checked && <span className="bg-ink size-2 rounded-full" />}
    </span>
  );
}

/** Everything inside a candidate card. The wrapper is the caller's. */
export function CandidateBody({ candidate }: { candidate: Candidate }) {
  const lastPost = shortDate(candidate.lastPost);

  return (
    <span className="gap-2xs grid text-left">
      <span className="gap-sm flex flex-wrap items-baseline">
        <span className="font-display text-lg">{candidate.title}</span>
        {/* One followed feed among several no longer collapses the whole result
            into "you already follow this" — so it has to say which. */}
        {candidate.following === true && (
          <span className="border-rule text-muted px-xs border py-0.5 text-xs">
            Already in your reader
          </span>
        )}
      </span>
      <span className="text-ink-2 text-sm break-words">{candidate.feedUrl}</span>
      <span className="gap-md text-muted num flex flex-wrap text-xs">
        <span>{FORMAT_NAME[candidate.format]}</span>
        <span>{candidate.items} items</span>
        {lastPost !== null && <span>Last post {lastPost}</span>}
        {/*
         * The EFFECTIVE cadence, not the computed one. A feed whose rhythm
         * earns a four-hour interval is still checked daily, because that is
         * how often the sweep runs (§6.4, M15).
         */}
        <span>Checked {everyPhrase(effectiveIntervalSeconds(candidate.intervalS))}</span>
      </span>
    </span>
  );
}

export const CARD_BASE =
  "gap-sm px-lg py-md grid grid-cols-[auto_minmax(0,1fr)] items-start border";
export const cardTone = (checked: boolean) =>
  checked ? "border-ink bg-paper-hi" : "border-rule bg-paper-hi/60 hover:bg-paper-hi";

/** The latest three, so a reader sees what they are about to follow. */
export function CandidatePreview({ candidate }: { candidate: Candidate }) {
  return (
    <aside className="bg-paper-2 px-lg py-md">
      <h3 className="font-display border-rule pb-xs mb-xs border-b text-lg">
        The latest three in {candidate.title}
      </h3>
      <ul className="m-0 grid list-none p-0">
        {candidate.preview.map((item) => (
          <li
            key={item.title + item.at}
            className="gap-sm border-rule py-xs flex items-baseline justify-between border-b text-sm last:border-b-0"
          >
            <span className="text-ink-2 min-w-0">{item.title}</span>
            {/* An undated item leaves the cell empty rather than printing
                "Invalid Date" beside a perfectly good title. */}
            <span className="text-muted num whitespace-nowrap">{shortDate(item.at) ?? ""}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * Each failure gets its own message and its own next action (§6.3).
 *
 * FOUR DISTINCT STATES, not one. A reader who pasted a site with no feed, one
 * that timed out, a feed they already follow and a typo need four different
 * next actions, and "something went wrong" serves none of them.
 */
export function DiscoveryFailure({
  result,
  onOpenFeed,
}: {
  result: Exclude<DiscoveryResult, { kind: "found" }>;
  /** The dialog closes itself instead of navigating; the page uses a link. */
  onOpenFeed?: (feedId: number) => void;
}) {
  const shell = "gap-sm border-rule bg-paper-hi px-lg py-md grid border";

  if (result.kind === "following") {
    return (
      <div className={shell}>
        <p className="gap-xs text-ink flex items-center font-medium">
          <TriangleAlert aria-hidden="true" className="size-4" />
          You already follow this feed
        </p>
        <p className="text-ink-2 text-sm">
          Nothing to add. Its articles are already in your reader.
        </p>
        <Button
          asChild={onOpenFeed === undefined}
          variant="outline"
          size="sm"
          className="justify-self-start"
          {...(onOpenFeed ? { onClick: () => onOpenFeed(result.feedId) } : {})}
        >
          {onOpenFeed === undefined ? (
            <Link href={`/feed/${result.feedId}`}>Open it</Link>
          ) : (
            "Open it"
          )}
        </Button>
      </div>
    );
  }

  const headline =
    result.kind === "none"
      ? "No feed at that address"
      : result.kind === "unreachable"
        ? "That address did not answer"
        : "That is not an address";

  return (
    <div className={shell}>
      <p className="gap-xs text-ink flex items-center font-medium">
        <TriangleAlert aria-hidden="true" className="size-4" />
        {headline}
      </p>
      <p className="text-ink-2 text-sm">{result.reason}</p>
      {result.kind === "unreachable" && (
        <p className="text-muted text-sm">
          A site that is briefly down is worth trying again. One that never answers is not a feed we
          can follow.
        </p>
      )}
    </div>
  );
}
