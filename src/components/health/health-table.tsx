import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { FetchLogEntry, Folder, SubscriptionWithUnread } from "@/lib/types";

/*
 * The feed-health table: the evidence screen.
 *
 * §6.2 is blunt about why it exists — `fetch_log` is THE ONLY EVIDENCE DEDUP
 * IS WORKING. Without this table, the ladder either works or does not and
 * nobody can tell which; the unread count looks the same either way.
 *
 * Every column is defined here at M5 and filled with real numbers at M10, so
 * the shape is settled before the data arrives rather than being designed
 * around whatever the scheduler happens to record.
 *
 * The hard part is the EMPTY CELLS, which is what M5's test is about. A feed
 * that has never been checked has no 304 ratio, and a feed whose items were
 * all new has no collapse rate. Rendering those as "0%" is a lie — it reads as
 * "nothing collapsed", when the truth is "there was nothing to collapse".
 */

const HHMM = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

const DAY_HHMM = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

const FORMAT_NAME: Record<string, string> = {
  rss2: "RSS 2.0",
  rss1: "RSS 1.0 (RDF)",
  atom: "Atom",
  json: "JSON Feed",
  unknown: "Unknown",
};

function everyPhrase(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400) * 24} h`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 60)} min`;
}

type State = { label: string; warn: boolean; detail: string };

/**
 * What a failing feed's error says, in the reader's words.
 *
 * `too_large` is OUR limit rather than the publisher's fault, so the copy says
 * so. It used to reach here as `parse` and render "Failing", which sends
 * somebody looking for a problem at the far end of a feed that is working
 * perfectly and is simply bigger than Cadence will fetch (§6.3).
 */
function detailFor(code: FetchLogEntry["code"] | undefined): string {
  if (code === "timeout") return "Timed out";
  if (code === "too_large") return "Too large to fetch";
  if (code === "html") return "A web page";
  return "Failing";
}

/**
 * The five states a feed can be in, and the one-line reason for each.
 *
 * `new` is not a `feeds.status` value — it is `cleanPolls` still under 3,
 * which is §6.1's "trusted slowly". Showing it matters: a reader who was
 * promised that on the add screen should be able to see it is true.
 */
function stateOf(sub: SubscriptionWithUnread): State {
  const { feed } = sub;
  switch (feed.status) {
    case "not_a_feed":
      return { label: "Not a feed", warn: true, detail: "A web page" };
    case "dead":
      /*
       * `detailFor` HERE TOO, which the first version of this change missed.
       *
       * An over-cap feed fails EVERY poll, so it reaches 20 consecutive
       * failures and is marked `dead` — at which point this branch took over
       * and said "Stopped — No answer". That is the exact message the change
       * set out to remove, arriving by a different route a few days later.
       */
      return {
        label: "Stopped",
        warn: true,
        detail:
          typeof feed.lastError?.code === "number"
            ? `${feed.lastError.code} not found`
            : detailFor(feed.lastError?.code),
      };
    case "backoff":
      return {
        label: "Retrying",
        warn: true,
        detail: detailFor(feed.lastError?.code),
      };
    default:
      /*
       * A demoted feed, BEFORE the "New" check.
       *
       * `guid_unstable` is permanent (§6.1) and `recordTrust` zeroes
       * `clean_polls` when it demotes — so a flagged feed satisfies both
       * branches, and this order is what decides which one shows. Reporting it
       * as "New" would say it is being treated cautiously while it proves
       * itself, when in fact it has already failed to.
       *
       * Says the LEARNED FACT, not what we do about it: the Collapsed column
       * on the same row already reads "92% by address", so an earlier wording
       * of "matched by address" made the row say it twice.
       *
       * Not a warning. The feed works; it just cannot be believed about its
       * own ids, which is a fact rather than a fault, and Appendix E asks this screen
       * to let a reader verify the deduplication rather than trust it.
       */
      if (feed.guidUnstable) {
        return { label: "Active", warn: false, detail: "Its ids changed on every build" };
      }
      if (feed.cleanPolls !== null && feed.cleanPolls < 3) {
        return { label: "New", warn: false, detail: "Matching by address first" };
      }
      return {
        label: "Active",
        warn: false,
        detail: feed.unchangedPolls > 0 ? "304 not modified" : "200 read",
      };
  }
}

/** A percentage, or the honest reason there is not one. */
function ratio(part: number, whole: number, noneLabel: string): string {
  if (whole === 0) return noneLabel;
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * The collapse rate, by rung.
 *
 * "None read" rather than "0%" when nothing was read at all, because 0% means
 * "items arrived and none were duplicates" — a real and different fact.
 */
function collapsed(sub: SubscriptionWithUnread): string {
  const { today } = sub.feed;
  if (today.seen === 0) return "None read";
  const merged = today.mergedByGuid + today.mergedByUrl + today.mergedByContent;
  if (merged === 0) return "0%";
  const pct = Math.round((merged / today.seen) * 100);
  // Named by the rung that did the work, which is the whole point: a feed
  // collapsing by ADDRESS is a feed whose GUIDs cannot be trusted (§6.1).
  const byUrl = today.mergedByUrl > today.mergedByGuid && today.mergedByUrl > today.mergedByContent;
  const byContent =
    today.mergedByContent > today.mergedByGuid && today.mergedByContent > today.mergedByUrl;
  return `${pct}%${byUrl ? " by address" : byContent ? " by text" : ""}`;
}

/**
 * The smallest sample this line will draw a conclusion from.
 *
 * Matches §6.1's own floor, which `guid-trust.ts` uses to decide whether a poll
 * is worth judging at all. A screen that states a verdict the detector would
 * refuse to make is telling the reader something the scheduler does not
 * believe.
 */
const MIN_JUDGED_TO_REPORT = 5;

/**
 * WHY it collapsed by address — the part the percentage cannot say.
 *
 * "92 % by address" has two completely different causes and the reader has to
 * be able to tell them apart:
 *
 *   the feed is NEW      rung 1 is not routing yet, so everything legitimately
 *                        matches at rung 2 and the publisher is faultless
 *   the ids CHURN        the publisher regenerates its guids on every build,
 *                        and rung 1 would insert a duplicate per item if it
 *                        were trusted
 *
 * Through the collapse rate alone those read identically, which is why M8
 * records `guid_agreed` / `guid_churned` separately. This is the line that
 * turns them into something a reader can act on, and Appendix E's "verify
 * rather than trust" is the reason it exists at all: a number with no
 * explanation is something you either believe or do not.
 *
 * Null when the day had nothing to judge — no matches, or TOO FEW to mean
 * anything. §6.1's own detector ignores polls under five items for exactly
 * that reason, and this line must not make a verdict the detector refuses to:
 * two items both churning is not evidence, and "ids all changed" from a sample
 * of two is the same mistake as rendering an unchecked feed's 304 ratio as
 * `0%`.
 *
 * The absolute verdicts are decided on the COUNTERS, not on the rounded
 * percentage. Rounding first says "ids held" when 1 of 401 items churned —
 * 0.25 % rounds to zero — which hides a real churn event on the screen built
 * to surface it, and says "ids all changed" when one item in three hundred
 * agreed.
 */
function idsHeld(sub: SubscriptionWithUnread): string | null {
  const { guidAgreed, guidChurned } = sub.feed.today;
  const judged = guidAgreed + guidChurned;
  if (judged < MIN_JUDGED_TO_REPORT) return null;

  if (guidChurned === 0) return "ids held";
  if (guidAgreed === 0) return "ids all changed";

  // Clamped away from the absolutes, so a non-zero churn never reads as none.
  const pct = Math.min(99, Math.max(1, Math.round((guidChurned / judged) * 100)));
  return `${pct}% of ids changed`;
}

export function HealthTable({
  subs,
  folders,
}: {
  subs: SubscriptionWithUnread[];
  folders: Folder[];
}) {
  // Feeds needing attention first: this is a screen you open because something
  // is wrong, so the wrong things go at the top.
  const order = { not_a_feed: 0, dead: 1, backoff: 2, active: 3 } as const;
  const sorted = [...subs].sort(
    (a, b) => (order[a.feed.status] ?? 9) - (order[b.feed.status] ?? 9) || a.feedId - b.feedId,
  );
  const folderName = (id: number | null) => folders.find((f) => f.id === id)?.name ?? "Unfiled";

  if (subs.length === 0) {
    return (
      <section className="gap-md px-xl py-3xl text-ink-2 grid justify-items-center text-center">
        <h2 className="font-display text-2xl">No feeds to report on</h2>
        <p className="max-w-[46ch]">
          Follow a feed and this table fills with its checks — how often it answered, how much it
          repeated itself, and when it is due next.
        </p>
        <Link
          href="/add"
          className="border-ink px-md py-xs hover:bg-paper-2 inline-flex min-h-10 items-center border no-underline"
        >
          Add a feed
        </Link>
      </section>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] border-collapse text-sm">
        <thead>
          <tr className="border-ink text-ink border-b text-left">
            {[
              "Feed",
              "State",
              "Last check",
              "Checks",
              "Not modified",
              "New",
              "Collapsed",
              "Checked every",
              "Next check",
            ].map((head, i) => (
              <th
                key={head}
                scope="col"
                className={`py-xs pr-md font-medium ${i >= 3 && i <= 5 ? "text-right" : ""}`}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((sub) => {
            const { feed } = sub;
            const state = stateOf(sub);
            const stopped = feed.status === "dead" || feed.status === "not_a_feed";
            /*
             * Suppressed for a flagged feed, because the State column already
             * says "Its ids changed on every build" — permanently, which is the
             * stronger statement. Showing "ids all changed" beside it makes the
             * row say one thing twice, which is the duplication `stateOf`'s own
             * comment records removing once already.
             */
            const ids = feed.guidUnstable ? null : idsHeld(sub);
            return (
              <tr key={sub.feedId} className="border-rule border-b align-top">
                <td className="py-sm pr-md">
                  <Link
                    href={`/settings/feeds/${sub.feedId}`}
                    className="gap-3xs grid no-underline"
                  >
                    <span className="font-display text-ink text-lg">
                      {sub.customTitle ?? feed.title}
                    </span>
                    <span className="text-muted text-xs">
                      {folderName(sub.folderId)}, {FORMAT_NAME[feed.format] ?? feed.format}
                    </span>
                  </Link>
                </td>
                <td className="py-sm pr-md">
                  <span
                    className={`gap-2xs flex items-center ${state.warn ? "text-ink font-medium" : "text-ink-2"}`}
                  >
                    {state.warn && <TriangleAlert aria-hidden="true" className="size-3.5" />}
                    {state.label}
                  </span>
                </td>
                <td className="py-sm pr-md text-ink-2 num">
                  <span className="gap-3xs grid">
                    <span>
                      {feed.lastError?.at && state.warn
                        ? DAY_HHMM(feed.lastError.at)
                        : feed.lastSuccessAt
                          ? HHMM(feed.lastSuccessAt)
                          : "Never"}
                    </span>
                    <span className="text-muted text-xs">{state.detail}</span>
                  </span>
                </td>
                <td className="py-sm pr-md num text-ink-2 text-right">{feed.today.checks}</td>
                <td className="py-sm pr-md num text-ink-2 text-right">
                  {ratio(feed.today.n304, feed.today.checks, "None")}
                </td>
                <td className="py-sm pr-md num text-ink-2 text-right">{feed.today.new}</td>
                <td className="py-sm pr-md text-ink-2 num">
                  <span className="gap-3xs grid">
                    <span>{collapsed(sub)}</span>
                    {/* The cause, when there is evidence for one. Omitted
                        entirely rather than shown as a zero — see `idsHeld`. */}
                    {ids !== null && <span className="text-muted text-xs">{ids}</span>}
                  </span>
                </td>
                <td className="py-sm pr-md text-ink-2 num">
                  {stopped ? "Not checked" : everyPhrase(feed.intervalS)}
                </td>
                <td className="py-sm text-ink-2 num">
                  {feed.nextFetchAt === null ? "None" : DAY_HHMM(feed.nextFetchAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
