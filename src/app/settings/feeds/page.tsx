import { AppBar } from "@/components/app-bar";
import { HealthTable } from "@/components/health/health-table";
import { TickTimeline } from "@/components/health/tick-timeline";
import { feedsNeedingAttention } from "@/components/sidebar";
import { listFolders, listSubscriptions, listTicks } from "@/lib/server/article-service";
import { requireViewer } from "@/lib/server/viewer";

/*
 * `GET /settings/feeds` — the health table and the tick timeline.
 *
 * The evidence screen (§6.2): `fetch_log` is the only proof the ladder works,
 * and this is where it is read. The glossary in the right rail is part of that
 * — a column headed "Collapsed" showing "92% by address" means nothing until
 * someone says what it counts, and the number it reports is the one that tells
 * you a publisher's GUIDs cannot be trusted.
 */
export default async function FeedHealthPage() {
  const viewer = await requireViewer();
  // `requireViewer()` redirected an anon away, so this is always a reader.
  const account = viewer.user;
  const [subs, folders, { ticks, budgetMs }] = await Promise.all([
    listSubscriptions(viewer),
    listFolders(viewer),
    listTicks(viewer),
  ]);

  const attention = feedsNeedingAttention(subs);
  const checksToday = subs.reduce((n, s) => n + s.feed.today.checks, 0);
  const feedTitleOf = (id: number) => {
    const sub = subs.find((s) => s.feedId === id);
    return sub ? (sub.customTitle ?? sub.feed.title) : "Unknown feed";
  };

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} current="feeds" />

      <main className="px-lg py-xl gap-2xl mx-auto grid max-w-[1400px]">
        {/* A plain grid now the "Add feed" link is gone: the dialog in the app
            bar adds feeds from every screen, so a second entry point here was
            a page a reader had to come back from. */}
        <header className="gap-xs grid">
          <h1>Feeds</h1>
          <p className="text-muted num text-sm">
            {subs.length} feeds, {attention.length} needing attention. {checksToday} checks since
            00:00 UTC.
          </p>
        </header>

        <section className="gap-md grid">
          <h2>Today, since 00:00 UTC</h2>
          <HealthTable subs={subs} folders={folders} />
        </section>

        <section className="gap-lg grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="gap-md grid min-w-0">
            <h2>The last six ticks that fetched</h2>
            <TickTimeline ticks={ticks} budgetMs={budgetMs} feedTitleOf={feedTitleOf} />
          </div>

          <aside className="gap-md grid">
            {[
              {
                title: "A tick",
                body:
                  "One run of the poll route. Vercel's cron starts one a day — its plan allows no " +
                  "more — and Fetch now starts one for a single feed. A tick claims whatever is " +
                  "due and stops claiming at 240 seconds, so a long queue finishes on the next one.",
              },
              {
                title: "Checked every",
                body:
                  "How often this feed is actually read, which is the daily tick for every feed " +
                  "here. Cadence works out a rhythm from how often each one posts, and cannot " +
                  "read anything more often than a tick runs.",
              },
              {
                title: "Not modified",
                body:
                  "The share of checks answered 304: nothing new, and nothing transferred. High " +
                  "is good — it means we asked politely and the publisher paid almost nothing " +
                  "to answer.",
              },
              {
                title: "Collapsed",
                body: "Of the items read, the share that matched an article already here by its address or its text.",
              },
              {
                title: "ids held · N% of ids changed",
                body:
                  "Under Collapsed: whether this feed's own article ids stayed put. A feed can " +
                  "collapse by address for two very different reasons — because it is new and not " +
                  "yet trusted on its ids, or because it changes them on every build. Only the " +
                  "second is the publisher's doing, and only this line tells them apart. Blank " +
                  "when too few items arrived to judge.",
              },
            ].map((item) => (
              <div key={item.title} className="gap-2xs border-rule pb-md grid border-b">
                <h3 className="text-ink">{item.title}</h3>
                <p className="text-ink-2 text-sm">{item.body}</p>
              </div>
            ))}
            <p className="border-rule bg-paper-hi text-ink-2 px-sm py-xs border text-xs leading-[1.45]">
              These figures are read from <code className="text-xs">fetch_log</code>, one row per
              check. They cover the current UTC day, so a feed checked only before midnight shows
              none.
            </p>
          </aside>
        </section>
      </main>
    </>
  );
}
