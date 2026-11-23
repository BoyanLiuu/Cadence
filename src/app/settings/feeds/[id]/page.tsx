import Link from "next/link";
import { notFound } from "next/navigation";

import { RevisionOverride } from "@/components/health/revision-override";
import { AppBar } from "@/components/app-bar";
import { getFeedHealth, listSubscriptions } from "@/lib/server/article-service";
import { requireViewer } from "@/lib/server/viewer";
import { strictId } from "@/lib/view-params";
import type { FetchLogEntry } from "@/lib/types";

/*
 * `GET /settings/feeds/:id` — one feed's checks (`ux-45` to `ux-50`).
 *
 * The drill-down from the health table. Where the table says a feed collapsed
 * 92% of its items by address, this says which checks did it — which is what
 * turns "the dedup is working" from an assertion into something a reader can
 * verify (§6.2).
 */

const DAY_HHMM = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** What one check did, in words rather than in codes. */
function outcome(entry: FetchLogEntry): string {
  if (entry.code === 304) return "Not modified";
  if (entry.code === "timeout") return "Timed out";
  if (entry.code === "html") return "Answered with a web page";
  if (entry.code === "parse") return "Could not be parsed";
  if (typeof entry.code === "number" && entry.code >= 400) return `Answered ${entry.code}`;

  const merged = entry.mergedByGuid + entry.mergedByUrl + entry.mergedByContent;
  const parts: string[] = [];
  if (entry.itemsNew > 0) parts.push(`${entry.itemsNew} new`);
  if (entry.mergedByGuid > 0) parts.push(`${entry.mergedByGuid} matched by ID`);
  if (entry.mergedByUrl > 0) parts.push(`${entry.mergedByUrl} matched by address`);
  if (entry.mergedByContent > 0) parts.push(`${entry.mergedByContent} matched by text`);
  if (entry.revised > 0) parts.push(`${entry.revised} revised`);
  if (parts.length === 0)
    return merged === 0 && entry.itemsSeen === 0 ? "Read, nothing in it" : "Read";
  return `Read, ${parts.join(", ")}`;
}

export default async function FeedChecksPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  // `requireViewer()` redirected an anon away, so this is always a reader.
  const account = viewer.user;

  const { id } = await params;
  const feedId = strictId(id);
  if (feedId === null) notFound();

  const subs = await listSubscriptions(viewer);
  const sub = subs.find((s) => s.feedId === feedId);
  // Not subscribed is a 404, not an empty page: the same rule the reader uses.
  if (!sub) notFound();

  const log = await getFeedHealth(viewer, feedId);
  const { feed } = sub;

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} current="feeds" />

      <main className="px-lg py-xl gap-lg mx-auto grid max-w-[1180px]">
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link href="/settings/feeds" className="text-ink-2 hover:text-ink">
            Feeds
          </Link>
        </nav>

        <header className="gap-xs grid">
          <h1>{sub.customTitle ?? feed.title}</h1>
          <p className="text-muted text-sm break-words">{feed.feedUrl}</p>
        </header>

        {feed.lastError && (
          <div className="gap-2xs border-rule bg-paper-hi px-lg py-md grid border">
            <p className="text-ink font-medium">Last failure</p>
            <p className="text-ink-2 text-sm">
              {DAY_HHMM(feed.lastError.at)} — {feed.lastError.text}
            </p>
            {feed.olderFailures !== undefined && (
              <p className="text-muted text-sm">
                {feed.olderFailures} earlier failures are folded out of the list below.
              </p>
            )}
          </div>
        )}

        <RevisionOverride sub={sub} />

        <section className="gap-md grid">
          <h2>Its checks</h2>
          {log.length === 0 ? (
            <p className="text-ink-2 border-rule bg-paper-hi px-lg py-md border text-sm">
              No checks recorded yet. A feed is checked once when you subscribe, and on its own
              schedule after that.
            </p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-ink text-ink border-b text-left">
                  <th scope="col" className="py-xs pr-md font-medium">
                    At
                  </th>
                  <th scope="col" className="py-xs pr-md font-medium">
                    Outcome
                  </th>
                  <th scope="col" className="py-xs pr-md text-right font-medium">
                    Items
                  </th>
                  <th scope="col" className="py-xs text-right font-medium">
                    Took
                  </th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.at} className="border-rule border-b">
                    <td className="py-sm pr-md num text-ink-2 whitespace-nowrap">
                      {DAY_HHMM(entry.at)}
                    </td>
                    <td className="py-sm pr-md text-ink-2">
                      {outcome(entry)}
                      {entry.note && <span className="text-muted"> · {entry.note}</span>}
                    </td>
                    <td className="py-sm pr-md num text-ink-2 text-right">
                      {entry.itemsSeen === 0 ? "—" : entry.itemsSeen}
                    </td>
                    <td className="py-sm num text-ink-2 text-right whitespace-nowrap">
                      {(entry.ms / 1000).toFixed(1)} s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
