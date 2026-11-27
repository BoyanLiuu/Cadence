import type { Tick } from "@/lib/types";

/*
 * The last six ticks, as bars against the 240 s budget.
 *
 * §6.4's budget made visible. One `POST /api/cron/poll` run claims the feeds
 * that are due and STOPS CLAIMING at 240 seconds; the whole shape of the sweep
 * follows from that number, so the screen that reports on it shows the number
 * rather than describing it.
 *
 * At M5 these are fixture ticks. M10 fills them from `fetch_log`, and the
 * column is where a budget overrun becomes visible instead of being inferred
 * from a timeout somewhere else.
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
  budgetMs,
  feedTitleOf,
}: {
  ticks: readonly Tick[];
  budgetMs: number;
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
          <th scope="col" className="py-xs pr-md text-muted font-medium">
            {Math.round(budgetMs / 1000)} s, where a tick stops claiming
          </th>
          <th scope="col" className="py-xs text-ink text-right font-medium">
            Took
          </th>
        </tr>
      </thead>
      <tbody>
        {ticks.map((tick) => {
          // Clamped, so a tick that OVERRAN still renders as a full bar rather
          // than overflowing its track — the number beside it tells the truth.
          const share = Math.min(1, tick.ms / budgetMs);
          const over = tick.ms > budgetMs;
          return (
            <tr key={tick.at} className="border-rule border-b align-top">
              <td className="py-sm pr-md num text-ink-2 whitespace-nowrap">{HHMM(tick.at)}</td>
              <td className="py-sm pr-md text-ink-2">
                <span className="gap-3xs grid">
                  {tick.work.map((work) => (
                    <span key={`${work.feedId}-${work.code}`}>{outcomeOf(work, feedTitleOf)}</span>
                  ))}
                </span>
              </td>
              <td className="py-sm pr-md">
                {/* The track IS the budget, so the bar's width is readable as
                    a fraction of it without reading the number. */}
                <span
                  role="img"
                  aria-label={`${(tick.ms / 1000).toFixed(1)} seconds of a ${Math.round(
                    budgetMs / 1000,
                  )} second budget`}
                  className="bg-rule relative block h-px w-full min-w-[8rem]"
                >
                  <span
                    className={`absolute top-1/2 left-0 h-[3px] -translate-y-1/2 ${
                      over ? "bg-error" : "bg-ink"
                    }`}
                    style={{ width: `${Math.max(share * 100, 0.6)}%` }}
                  />
                  {/* The budget line itself, in the accent. */}
                  <span className="bg-accent absolute top-1/2 right-0 h-2.5 w-px -translate-y-1/2" />
                </span>
              </td>
              <td className="py-sm num text-ink-2 text-right whitespace-nowrap">
                {(tick.ms / 1000).toFixed(1)} s
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
