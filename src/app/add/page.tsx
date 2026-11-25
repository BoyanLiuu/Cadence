import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import { AppBar } from "@/components/app-bar";

import { SubscribeForm } from "./subscribe-form";
import { subscribeToFeed } from "./subscribe.action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sampleAddresses } from "@/lib/fixtures/discover";
import { dataSource, listFolders, listSubscriptions } from "@/lib/server/article-service";
import { discoverFeeds } from "@/lib/server/mutations";
import { requireViewer } from "@/lib/server/viewer";
import { trimmedParam } from "@/lib/view-params";
import type { Candidate, DiscoveryResult } from "@/lib/types";

/*
 * `GET /add` — paste an address, pick a feed, subscribe.
 *
 * The right rail is a REQUIREMENT, not decoration (Appendix E). "Checked about
 * half as often as it posts · each article once · trusted slowly" is the
 * product's contract stated to the reader, and "trusted slowly" is §6.1's
 * `cleanPolls < 3` made visible: a new feed has rung 2 run as a pre-check
 * until it has proved its GUIDs are stable. It is the only place the app
 * explains why it is not instant, and a first implementation always drops it.
 */

/*
 * `null` for a date that is not one, rather than the string "Invalid Date".
 *
 * The fixtures always carried a date, so this was `new Date(iso).toLocale…`
 * outright. A real feed need not: plenty of RSS omits `pubDate` entirely, and
 * `Candidate.lastPost` is `""` when no item has a date — which rendered "Last
 * post Invalid Date" under every candidate from such a feed. Callers omit the
 * line instead.
 */
const DATE = (iso: string): string | null => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

const FORMAT_NAME: Record<Candidate["format"], string> = {
  rss2: "RSS 2.0",
  rss1: "RSS 1.0 (RDF)",
  atom: "Atom",
  json: "JSON Feed",
  unknown: "Unknown",
};

/** "about every 24 h" — the interval in the words the rail uses. */
function everyPhrase(seconds: number): string {
  if (seconds >= 86400) return `about every ${Math.round(seconds / 86400) * 24} h`;
  if (seconds >= 3600) return `about every ${Math.round(seconds / 3600)} h`;
  return `about every ${Math.round(seconds / 60)} min`;
}

function CandidateCard({
  candidate,
  checked,
  address,
}: {
  candidate: Candidate;
  checked: boolean;
  address: string;
}) {
  const lastPost = DATE(candidate.lastPost);

  return (
    <Link
      href={`/add?address=${encodeURIComponent(address)}&feed=${encodeURIComponent(candidate.feedUrl)}`}
      scroll={false}
      aria-current={checked ? "true" : undefined}
      className={`gap-sm px-lg py-md grid grid-cols-[auto_minmax(0,1fr)] items-start border no-underline ${
        checked ? "border-ink bg-paper-hi" : "border-rule bg-paper-hi/60 hover:bg-paper-hi"
      }`}
    >
      {/* A radio's appearance without a radio's behaviour: selection is the
          URL, so the server can render the matching preview. */}
      <span
        aria-hidden="true"
        className={`border-ink mt-1.5 grid size-4 place-items-center rounded-full border ${
          checked ? "" : "border-muted"
        }`}
      >
        {checked && <span className="bg-ink size-2 rounded-full" />}
      </span>
      <span className="gap-2xs grid">
        <span className="gap-sm flex flex-wrap items-baseline">
          <span className="font-display text-lg">{candidate.title}</span>
          {/* One followed feed among several no longer collapses the whole
              result into "you already follow this" — so it has to say which. */}
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
          <span>Checked {everyPhrase(candidate.intervalS)}</span>
        </span>
      </span>
    </Link>
  );
}

function Preview({ candidate }: { candidate: Candidate }) {
  return (
    <aside className="bg-paper-2 px-lg py-md">
      <h2 className="font-display border-rule pb-xs mb-xs border-b text-lg">
        The latest three in {candidate.title}
      </h2>
      <ul className="m-0 grid list-none p-0">
        {candidate.preview.map((item) => (
          <li
            key={item.title + item.at}
            className="gap-sm border-rule py-xs flex items-baseline justify-between border-b text-sm last:border-b-0"
          >
            <span className="text-ink-2 min-w-0">{item.title}</span>
            {/* An undated item leaves the cell empty rather than printing
                "Invalid Date" beside a perfectly good title. */}
            <span className="text-muted num whitespace-nowrap">{DATE(item.at) ?? ""}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Each failure gets its own message and its own next action. */
function Failure({ result }: { result: Exclude<DiscoveryResult, { kind: "found" }> }) {
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
        <Button asChild variant="outline" size="sm" className="justify-self-start">
          <Link href={`/feed/${result.feedId}`}>Open it</Link>
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

export default async function AddFeedPage({
  searchParams,
}: {
  // Every value may arrive as an ARRAY: `?address=x&address=y` is a URL
  // anyone can send, and nothing stops them.
  searchParams: Promise<{ address?: string | string[]; feed?: string | string[] }>;
}) {
  const viewer = await requireViewer();
  // `requireViewer()` redirected an anon away, so this is always a reader.
  const account = viewer.user;
  const [folders, subs] = await Promise.all([listFolders(viewer), listSubscriptions(viewer)]);

  const { address, feed } = await searchParams;
  const typed = trimmedParam(address);
  const result = typed === "" ? null : await discoverFeeds(viewer, typed);

  /*
   * Which candidate the preview describes, carried in the URL.
   *
   * It used to be pinned to `candidates[0]` while the radio group was
   * uncontrolled, so on the headline sample — which has TWO feeds — picking
   * "Tidewater Letters: comments" still previewed the main feed under a
   * heading naming it. A preview that describes something other than what is
   * selected is worse than no preview: this screen's whole job is to let
   * someone see what they are about to follow.
   *
   * In the URL rather than client state for the same reason the reader's
   * cursor is: the view IS the address, so a chosen candidate is shareable and
   * survives a reload.
   */
  const wanted = trimmedParam(feed);
  const chosen =
    result?.kind === "found"
      ? (result.candidates.find((c) => c.feedUrl === wanted) ?? result.candidates[0])
      : null;

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} current="none" />

      <main className="px-lg py-xl gap-xl mx-auto grid max-w-[1180px] lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="gap-lg grid">
          <header className="gap-xs grid">
            <h1>Add a feed</h1>
            <p className="lead text-ink-2">
              Paste a feed&rsquo;s address or the site&rsquo;s own, and Cadence finds the feed.
            </p>
          </header>

          <form className="gap-2xs grid max-w-[46rem]">
            <label htmlFor="address" className="text-sm font-medium">
              Feed or site address
            </label>
            <div className="gap-xs flex">
              <Input
                id="address"
                name="address"
                defaultValue={typed}
                placeholder="example.com or example.com/feed"
                className="min-w-0 flex-1"
              />
              <Button type="submit" variant="outline">
                Find feeds
              </Button>
            </div>
            <p className="text-muted text-sm">http or https. Without either, https is assumed.</p>
          </form>

          {/*
           * ONLY IN FIXTURES MODE. These five `.example` addresses resolve
           * against the sample map, and M12 made discovery real — so with a
           * database they are five links that each fetch nothing and report
           * "that address did not answer", under a heading promising they
           * resolve and a line saying discovery is not networked yet. The
           * copy outlived the milestone it described.
           */}
          {result === null && dataSource !== "db" && (
            <section className="gap-sm grid">
              <h2 className="font-display text-lg">Addresses that resolve in this build</h2>
              <p className="text-muted text-sm">
                This build has no database, so discovery answers from a sample map rather than the
                web. These five addresses stand in — one for each way the search can end.
              </p>
              <ul className="gap-2xs m-0 grid list-none p-0">
                {sampleAddresses.map(({ address: sample, branch }) => (
                  <li key={sample}>
                    <Link
                      href={`/add?address=${encodeURIComponent(sample)}`}
                      className="gap-sm border-rule bg-paper-hi px-md py-xs hover:bg-paper-2 flex flex-wrap items-baseline justify-between border text-sm no-underline"
                    >
                      <span className="text-ink font-medium">{sample}</span>
                      <span className="text-muted text-xs">{branch}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result?.kind === "found" && (
            /*
             * KEYED ON THE CHOSEN FEED, so changing the selection remounts the
             * form and clears `useActionState`. Without it the component stays
             * mounted across candidate and address changes, and a
             * "that folder does not exist" alert hangs under a different feed.
             */
            <SubscribeForm key={chosen?.feedUrl ?? "none"} action={subscribeToFeed}>
              <input type="hidden" name="address" value={typed} />
              <input type="hidden" name="feedUrl" value={chosen?.feedUrl ?? ""} />
              <section className="gap-md grid lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
                <div className="gap-2xs grid">
                  <p className="num text-sm font-medium">
                    {result.candidates.length} {result.candidates.length === 1 ? "feed" : "feeds"}{" "}
                    at this address
                  </p>
                  <div className="gap-xs grid">
                    {result.candidates.map((candidate) => (
                      <CandidateCard
                        key={candidate.feedUrl}
                        candidate={candidate}
                        checked={candidate.feedUrl === chosen?.feedUrl}
                        address={typed}
                      />
                    ))}
                  </div>
                </div>
                {chosen && <Preview candidate={chosen} />}
              </section>

              <div className="gap-lg grid sm:grid-cols-2 lg:max-w-[46rem]">
                <div className="gap-2xs grid">
                  <label htmlFor="folder" className="text-sm font-medium">
                    Folder
                  </label>
                  <select
                    id="folder"
                    name="folderId"
                    className="border-rule bg-paper-hi px-sm text-ink h-10 rounded-[2px] border"
                  >
                    {/* FIRST, so it is the default. It was last, which made
                        the reader's first folder the default — and now that
                        this form writes, subscribing without touching the
                        select filed the feed somewhere nobody chose. */}
                    <option value="">No folder</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gap-2xs grid">
                  <label htmlFor="customTitle" className="text-sm font-medium">
                    Name in your sidebar <span className="text-muted">(optional)</span>
                  </label>
                  <Input id="customTitle" name="customTitle" />
                  <p className="text-muted text-sm">
                    Leave it empty to use the feed&rsquo;s own name.
                  </p>
                </div>
              </div>

              <p className="border-rule bg-paper-hi text-ink-2 px-sm py-xs max-w-[46rem] border text-xs leading-[1.45]">
                Discovery reads the sample map rather than the web until M12 — subscribing is real.
              </p>
            </SubscribeForm>
          )}

          {result !== null && result.kind !== "found" && <Failure result={result} />}

          {result !== null && (
            <Link href="/add" className="text-ink-2 hover:text-ink justify-self-start text-sm">
              Try another address
            </Link>
          )}
        </div>

        <aside className="gap-md grid self-start">
          <h2 className="font-display border-ink pb-xs border-b text-xl">
            What Cadence does with a new feed
          </h2>
          {[
            {
              title: "Its own schedule",
              body: "Checked about half as often as it posts, never more than every 15 minutes or less than daily.",
            },
            {
              title: "Each article once",
              body: "A story another feed already brought in becomes one row, not two.",
            },
            {
              title: "Trusted slowly",
              body: "For its first 3 checks, articles are matched by address before their IDs.",
            },
          ].map((item) => (
            <div key={item.title} className="gap-2xs border-rule pb-md grid border-b">
              <h3 className="text-ink">{item.title}</h3>
              <p className="text-ink-2 text-sm">{item.body}</p>
            </div>
          ))}
          <p className="text-muted text-xs">
            {subs.length} {subs.length === 1 ? "feed" : "feeds"} followed.
          </p>
        </aside>
      </main>
    </>
  );
}
