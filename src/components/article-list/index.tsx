import { Search } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Article, type Cursor, type Page, type Scope } from "@/lib/types";
import { hrefForNewResultSet, hrefWith, type ReaderParams } from "@/lib/view-params";

import { MarkAllRead } from "./mark-all-read";
import { MarkReadOnScroll } from "./mark-read-on-scroll";
import { ScrollOpenIntoView } from "./scroll-open-into-view";
import { ArticleBadges } from "./revised-badge";

/*
 * The middle pane: a keyset-paginated list, the Unread/All toggle and title
 * search.
 *
 * THE CURSOR LIVES IN THE URL, as `?before=<publishedAt>,<id>`. The fixture is
 * a static array and this would work just as well in React state — which is
 * exactly why it is worth writing down now. M9 makes paging real; if the
 * cursor were component state, the shape would have to change then, and every
 * deep link, reload and back-button press would behave differently before and
 * after. Keeping it in the URL costs nothing today and keeps the component
 * untouched later.
 *
 * NEVER `OFFSET` (N6). The service does the keying; `no-offset.test.ts` fails
 * the build if an offset appears anywhere in `src/lib/server/`.
 */

export type ListState =
  | { kind: "rows"; page: Page<Article> }
  | { kind: "all-read"; nextFetch: { title: string; at: string } | null }
  | { kind: "no-matches"; query: string }
  | { kind: "feed-empty"; feedTitle: string }
  /** `since` and `lastGood` are ISO instants; this component formats them. */
  | { kind: "not-a-feed"; feedTitle: string; since: string | null; lastGood: string | null }
  /** Paged past the last row. Distinct from "all read" on purpose. */
  | { kind: "past-end" }
  | { kind: "failed" };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** `?before=<publishedAt>,<id>`, the one shape M9 must not have to change. */
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.publishedAt},${cursor.id}`;
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  const comma = value.lastIndexOf(",");
  if (comma === -1) return undefined;
  const publishedAt = value.slice(0, comma);
  const id = Number.parseInt(value.slice(comma + 1), 10);
  // A malformed cursor returns undefined rather than throwing: a stale or
  // hand-edited link should land on the first page, not on an error.
  if (!Number.isFinite(id) || Number.isNaN(Date.parse(publishedAt))) return undefined;
  return { publishedAt, id };
}

function Row({
  article,
  feedTitle,
  open,
  params,
}: {
  article: Article;
  feedTitle: string;
  open: boolean;
  params: ReaderParams;
}) {
  const read = article.readAt !== null;

  /*
   * READ STATE IS STYLED FROM `data-dimmed`, NOT FROM THE `read` BOOLEAN, and
   * the indirection is the point: `mark-read-on-scroll.tsx` sets that attribute
   * optimistically as a row scrolls past, so one selector renders both the
   * database's answer and the client's guess. A row whose mark is later
   * confirmed by the server changes nothing visually, which is what optimistic
   * is supposed to mean.
   *
   * `data-article-id` is how that component finds its rows without the list
   * being lifted into the client.
   *
   * The 150 ms is Appendix F's figure, and `transition-colors` is the whole
   * animation — COLOUR ONLY, no size, no opacity on the row box. The reader is
   * scrolling, and anything that moves layout under a thumb loses their place.
   *
   * ONE ATTRIBUTE CARRIES THE WHOLE DECISION, `read AND NOT open`, computed
   * here. Two attempts got it wrong and both are worth recording:
   *
   *   A muted rule plus an open rule to override it — equal specificity, so
   *   which wins is whichever Tailwind emits last, and it emits `read` last.
   *   That left an OPENED row muted.
   *
   *   Stacking the variants, `in-data-[read=true]:in-data-[open=false]:`. That
   *   compiles to `:where([data-open=false]) :where([data-read=true]) …` — two
   *   ANCESTORS — and both attributes sit on this one `<li>`, so it matches
   *   nothing at all. Found by grepping the built stylesheet, not by reasoning.
   *
   * So the condition is evaluated in TypeScript, where it is a boolean rather
   * than a specificity question. `mark-read-on-scroll.tsx` sets the same
   * attribute and skips open rows, so the two sides agree by construction.
   */
  return (
    <li
      className="border-rule border-b"
      data-article-id={article.id}
      data-open={open ? "true" : "false"}
      data-dimmed={read && !open ? "true" : "false"}
    >
      <Link
        // Keeps scope, search, folder AND the page: clicking a row on page 2
        // of All must not land on page 1 of Unread.
        href={hrefWith(params, { article: String(article.id) })}
        scroll={false}
        aria-current={open ? "true" : undefined}
        className="gap-2xs px-lg py-md hover:bg-paper-2 in-data-[open=true]:bg-paper-hi grid no-underline transition-colors duration-150"
      >
        <span className="gap-sm text-ink-2 num flex justify-between text-xs font-medium">
          <span className="in-data-[dimmed=true]:text-muted transition-colors duration-150">
            {feedTitle}
          </span>
          <span className="text-muted">{hhmm(article.publishedAt)}</span>
        </span>
        <span className="font-display text-ink in-data-[dimmed=true]:text-muted text-lg leading-[1.25] tracking-[-0.005em] text-pretty transition-colors duration-150">
          {article.title}
        </span>
        <span className="text-muted text-sm">{article.summary}</span>
        <ArticleBadges article={article} />
      </Link>
    </li>
  );
}

/** The five designed states, each with its own copy. None is a blank pane. */
function Empty({
  state,
  params,
}: {
  state: Exclude<ListState, { kind: "rows" }>;
  params: ReaderParams;
}) {
  const wrap = "gap-md px-xl py-3xl grid justify-items-center text-center text-ink-2";

  switch (state.kind) {
    case "all-read":
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">
            Nothing unread
            <br />
            in any feed
          </h2>
          <p className="max-w-[46ch]">
            Feeds are checked on their own schedules.
            {state.nextFetch
              ? ` The next is ${state.nextFetch.title}, at ${hhmm(state.nextFetch.at)}.`
              : ""}
          </p>
          <Button asChild variant="outline">
            <Link href={hrefForNewResultSet(params, { scope: "all" })}>Show all articles</Link>
          </Button>
        </div>
      );

    case "no-matches":
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">No titles match</h2>
          <p className="max-w-[46ch]">
            Nothing in this view has <strong>{state.query}</strong> in its title. Search looks at
            titles only.
          </p>
          <Button asChild variant="outline">
            <Link href={hrefForNewResultSet(params, { q: null })}>Clear the search</Link>
          </Button>
        </div>
      );

    case "feed-empty":
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">Nothing here yet</h2>
          <p className="max-w-[46ch]">
            {state.feedTitle} has been checked, and it has published nothing we have not already
            shown you.
          </p>
        </div>
      );

    case "not-a-feed":
      // §6.3 calls this the architecture's most common user-reported failure,
      // so it says plainly what happened and when the feed last worked —
      // rather than looking like a feed that simply went quiet.
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">This address stopped being a feed</h2>
          <p className="max-w-[46ch]">
            {state.feedTitle} answers with a web page instead of a feed
            {state.since ? `, as of ${day(state.since)}` : ""}. Checks have stopped.
            {state.lastGood ? ` The last good check was ${day(state.lastGood)}.` : ""}
          </p>
          <Button asChild variant="outline">
            <Link href="/settings/feeds">See its checks</Link>
          </Button>
        </div>
      );

    case "past-end":
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">Nothing older</h2>
          <p className="max-w-[46ch]">
            You have reached the end of this view. Older articles may have been pruned, or this is
            simply all there is.
          </p>
          <Button asChild variant="outline">
            <Link href={hrefWith(params, { before: null })}>Back to the newest</Link>
          </Button>
        </div>
      );

    case "failed":
      return (
        <div className={wrap}>
          <h2 className="font-display text-2xl">That did not load</h2>
          <p className="max-w-[46ch]">
            Nothing was lost — your read state is on the server. Try again.
          </p>
          <Button asChild variant="outline">
            <Link href={hrefWith(params, {})}>Try again</Link>
          </Button>
        </div>
      );
  }
}

export function ArticleList({
  title,
  unreadCount,
  state,
  scope,
  query,
  openArticleId,
  articleFeedTitle,
  params,
}: {
  title: string;
  unreadCount: number;
  state: ListState;
  scope: Scope;
  query: string;
  openArticleId: number | null;
  /**
   * An ARTICLE's label, which is not its owning feed's name.
   *
   * Rung 2 is global, so a row can be here because a feed the reader follows
   * delivered it while `articles.feed_id` names one they do not. See
   * `lib/article-feed.ts`.
   */
  articleFeedTitle: (article: Article) => string;
  params: ReaderParams;
}) {
  const unreadOnly =
    scope.kind === "unread" ||
    ((scope.kind === "feed" || scope.kind === "folder") && scope.unreadOnly === true);

  return (
    <section
      aria-label="Articles"
      className="border-rule flex min-h-[calc(100dvh-var(--bar-height))] min-w-0 flex-col border-r"
    >
      <div className="gap-2xs px-lg pt-lg pb-md grid">
        <h1 className="text-3xl">{title}</h1>
        <p className="text-muted num min-h-[1lh] text-sm">{unreadCount} unread</p>

        <div className="gap-sm mt-xs flex flex-wrap items-center justify-between">
          {/* Links rather than a client toggle: the view IS the URL, so Unread
              and All are navigable, shareable and restored on reload. */}
          <div className="inline-flex">
            <Link
              href={hrefForNewResultSet(params, { scope: "unread" })}
              aria-current={unreadOnly ? "true" : undefined}
              className="border-muted bg-paper-hi text-ink-2 px-sm aria-[current]:border-ink aria-[current]:bg-ink aria-[current]:text-paper hover:bg-paper-2 inline-flex min-h-8 items-center rounded-l-[2px] border font-medium no-underline transition-colors"
            >
              Unread
            </Link>
            <Link
              href={hrefForNewResultSet(params, { scope: "all" })}
              aria-current={!unreadOnly ? "true" : undefined}
              className="border-muted bg-paper-hi text-ink-2 px-sm aria-[current]:border-ink aria-[current]:bg-ink aria-[current]:text-paper hover:bg-paper-2 -ml-px inline-flex min-h-8 items-center rounded-r-[2px] border font-medium no-underline transition-colors"
            >
              All
            </Link>
          </div>

          {/* `query` goes with the scope: the button marks what is on screen,
              and a search term is part of that. */}
          <MarkAllRead
            scope={scope}
            filter={query ? { query } : undefined}
            unreadCount={unreadCount}
          />
        </div>

        {/* GET to the current path: the search term becomes part of the URL,
            so a result page is shareable and survives a reload. The hidden
            fields carry the rest of the view, which a bare form would drop. */}
        <form className="gap-xs mt-xs flex items-center">
          <input type="hidden" name="scope" value={unreadOnly ? "unread" : "all"} />
          {params.folder !== undefined && (
            <input type="hidden" name="folder" value={params.folder} />
          )}
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search titles"
              aria-label="Search titles"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </div>

      <div className="border-ink flex-1 border-t">
        {state.kind === "rows" ? (
          <>
            {/*
             * Marks rows read as they scroll past, optimistically, flushed in
             * batches. Mounted only where there is something to mark — an
             * all-read list needs no observer — and it renders nothing, so it
             * costs the list no layout.
             */}
            <MarkReadOnScroll enabled={state.page.items.some((a) => a.readAt === null)} />
            {/*
             * Brings the open row into view when the list ARRIVES with one
             * open — from `/saved`, a shared link, or a reload. Rows link with
             * `scroll={false}` so a click never moves the list; this fires
             * once per article id and skips a row already fully visible, so
             * the two do not fight. See the note in the component.
             */}
            <ScrollOpenIntoView articleId={openArticleId} />
            <ul className="m-0 list-none p-0">
              {state.page.items.map((a) => (
                <Row
                  key={a.id}
                  article={a}
                  feedTitle={articleFeedTitle(a)}
                  open={a.id === openArticleId}
                  params={params}
                />
              ))}
            </ul>
            <div className="px-lg py-lg gap-sm flex items-center justify-between">
              <span className="text-muted num text-xs">
                {state.page.items.length} {state.page.items.length === 1 ? "article" : "articles"}
              </span>
              {state.page.next && (
                <Button asChild variant="outline" size="sm">
                  {/* Keeps scope, search and folder: a cursor taken from one
                      result set is meaningless applied to another. */}
                  <Link href={hrefWith(params, { before: encodeCursor(state.page.next) })}>
                    Older
                  </Link>
                </Button>
              )}
            </div>
          </>
        ) : (
          <Empty state={state} params={params} />
        )}
      </div>
    </section>
  );
}
