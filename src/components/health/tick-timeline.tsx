import type { Tick } from "@/lib/types";

/*
 * The last six ticks, and what each of them fetched.
 *
 * WHAT THIS USED TO BE, because the change is the interesting part. It drew a
 * bar per tick against the 240-second claiming budget, with a duration beside
 * it — and that duration was `max(duration_ms)` over the feeds in the tick:
 * the longest single HTTP request. So the bar compared ONE FEED'S REQUEST to
 * the budget for claiming ALL OF THEM, and the number beside it was headed
 * "Took", which everybody read as the tick's duration.
 *
 * Relabelling it "Slowest fetch" made it true and left it useless. It was not
 * the tick's wall-clock (polls run six at a time, so a tick is longer than any
 * one of them and shorter than their sum), not what "Fetch now" takes
 * (measured: ~800 ms making the feed due and ~900 ms redrawing the page, on
 * top of the fetch), and not a figure any question on this screen needed. So
 * the column went, and `fetch_log.duration_ms` went with it.
 *
 * WHAT IS LEFT IS THE CLAIM APPENDIX E ASKS FOR: which feeds a tick touched
 * and what each one answered. The 304s, the collapse rates and the ids-held
 * line are all still here — they are the evidence that deduplication works,
 * and a response time never was.
 */

const HHMM = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** Outcome copy for one feed's part of a tick. */
function outcomeOf(work: Tick["work"][number], feedTitleOf: (id: number) => string): string {
  const title = feedTitleOf(work.feedId);
  if (work.code === 304) return `${title}, not modified`;
  if (work.code === "timeout") return `${title}, timed out`;
  if (work.code === "html") return `${title}, answered with a web page`;
  if (work.code === "parse") return `${title}, could not be parsed`;
  if (work.code === "too_large") return `${title}, larger than Cadence will fetch`;
  if (typeof work.code === "number" && work.code >= 400) return `${title}, answered ${work.code}`;
  return work.note ? `${title}, read, ${work.note}` : `${title}, read`;
}

export function TickTimeline({
  ticks,
  feedTitleOf,
}: {
  ticks: readonly Tick[];
  feedTitleOf: (feedId: number) => string;
}) {
  if (ticks.length === 0) {
    return (
      <p className="text-ink-2 border-rule bg-paper-hi px-lg py-md border text-sm">
        No tick has fetched anything today. Fetch a feed below to run one now.
      </p>
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-ink border-b text-left">
          <th scope="col" className="py-xs pr-md text-ink font-medium">
            Tick
          </th>
          <th scope="col" className="py-xs pr-md text-ink font-medium">
            Fetched
          </th>
        </tr>
      </thead>
      <tbody>
        {ticks.map((tick) => (
          <tr key={tick.at} className="border-rule border-b align-top">
            <td className="py-sm pr-md num text-ink-2 whitespace-nowrap">{HHMM(tick.at)}</td>
            <td className="py-sm pr-md text-ink-2">
              <span className="gap-3xs grid">
                {tick.work.map((work) => (
                  <span key={`${work.feedId}-${work.code}`}>{outcomeOf(work, feedTitleOf)}</span>
                ))}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
