import { Search } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Article, type Page, type Scope } from "@/lib/types";
import { hrefForNewResultSet, hrefWith, type ReaderParams } from "@/lib/view-params";

import { MarkAllRead } from "./mark-all-read";
import { MarkReadOnScroll } from "./mark-read-on-scroll";
import { PageSwap } from "./page-swap";
import { ScrollOpenIntoView } from "./scroll-open-into-view";
import { ArticleBadges } from "./revised-badge";

/*
 * The middle pane: a numbered-page list, the Unread/All toggle and title
 * search.
 *
 * THE PAGE LIVES IN THE URL, as `?page=`, and page 1 is written as no
 * parameter at all. It would work just as well in React state, which is
 * exactly why it is worth writing down: in state, a deep link, a reload and
 * the back button would all behave differently from a click, and the reading
 * pane beside this one is reached by URL too.
 *
 * IT WAS A KEYSET CURSOR (`?before=<publishedAt>,<id>`) and §3 forbade
 * `OFFSET` outright. Numbered pages cannot be built on a cursor, so that rule
 * was reversed deliberately — `types.ts` holds the decision and its two costs,
 * and `offset-only-in-list.test.ts` (which was `no-offset.test.ts`) now keeps
 * the offset to the single query that paginates.
 */

export type ListState =
  | { kind: "rows"; page: Page<Article> }
  | { kind: "all-read"; nextFetch: { title: string; at: string } | null }
  | { kind: "no-matches"; query: string }
  | { kind: "feed-empty"; feedTitle: string }
  /** `since` and `lastGood` are ISO instants; this component formats them. */
  | { kind: "not-a-feed"; feedTitle: string; since: string | null; lastGood: string | null }
  /** Paged past the last row. Distinct from "all read" on purpose. */
  | { kind: "past-end"; pages: number; total: number }
  | { kind: "failed" };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/**
 * `?page=` as a page number, or page 1.
 *
 * REPLACED A CURSOR CODEC — `encodeCursor`/`decodeCursor`, which packed
 * `<publishedAt>,<id>` into the URL. A page number needs no codec, and it
 * fails more kindly: anything that is not a positive integer lands the reader
 * on page 1 rather than on an error, which is what a hand-edited or stale link
 * deserves.
 */
export function pageFromParam(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return 1;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 1;
}

/**
 * How many numbered buttons to draw before falling back to a window.
 *
 * Seven fits the list pane's width at every breakpoint the reader uses. Past
 * that the pager shows a window around the current page with the first and
 * last always reachable, because "jump to the end" is a real thing readers do
 * and a long list should not need thirty presses to reach it.
 */
const PAGER_WINDOW = 7;

/**
 * The page numbers to show, with `null` standing for a gap.
 *
 * EXPORTED, AND NOT YET TESTED — said plainly because the first version of
 * this note implied otherwise. The arithmetic below was checked by running it
 * over the cases that matter (a short list, the current page at either end,
 * the middle); those outputs are recorded here so the next person can see what
 * it is supposed to do, but nothing asserts them:
 *
 *   page  1 of  3   1 2 3
 *   page  4 of  7   1 2 3 4 5 6 7
 *   page  1 of 20   1 2 3 4 5 6 … 20
 *   page 10 of 20   1 … 8 9 10 11 12 … 20
 *   page 20 of 20   1 … 15 16 17 18 19 20
 */
export function pagesToShow(page: number, pages: number): (number | null)[] {
  if (pages <= PAGER_WINDOW) return Array.from({ length: pages }, (_, i) => i + 1);

  /*
   * ALWAYS THE FIRST AND LAST, then a window around the current page, clamped
   * at both ends. That keeps the pager within one slot of a fixed width (eight
   * at the ends, nine in the middle where both gaps show) — without the clamp
   * it grows and shrinks as the reader pages and the buttons move under the
   * pointer pressing them.
   */
  const span = PAGER_WINDOW - 2;
  let start = Math.max(2, page - Math.floor((span - 1) / 2));
  const end = Math.min(pages - 1, start + span - 1);
  start = Math.max(2, end - span + 1);

  const out: (number | null)[] = [1];
  if (start > 2) out.push(null);
  for (let p = start; p <= end; p++) out.push(p);
  if (end < pages - 1) out.push(null);
  out.push(pages);
  return out;
}

/**
 * Numbered pages, newest first.
 *
 * REPLACED ONE "Older" BUTTON, which is worth recording because the button was
 * not merely limited — it was one-way. A keyset cursor can only say "the rows
 * after this one", so there was no Newer, no way to tell page 4 from page 40,
 * and no way to reach either except by pressing Older until you arrived. The
 * browser's Back button was the only way home.
 *
 * `page=1` IS WRITTEN AS NO PARAMETER AT ALL (`page: null` drops it), so the
 * first page has one URL rather than two. Otherwise `/reader` and
 * `/reader?page=1` are the same list under different addresses, which splits
 * Next's prefetch cache and makes `aria-current` comparisons wrong.
 */
function Pager({ page, params }: { page: Page<Article>; params: ReaderParams }) {
  if (page.pages <= 1) return null;

  const href = (n: number) => hrefWith(params, { page: n === 1 ? null : String(n) });

  return (
    <nav aria-label="Pages" className="gap-2xs flex flex-wrap items-center">
      {pagesToShow(page.page, page.pages).map((n, i) =>
        n === null ? (
          /* A gap, not a button. `aria-hidden` because "…" read aloud between
             two page numbers is noise, and the numbers either side say it. */
          <span key={`gap-${i}`} aria-hidden="true" className="text-muted px-2xs text-sm">
            …
          </span>
        ) : (
          <Button
            key={n}
            asChild
            size="sm"
            variant={n === page.page ? "default" : "outline"}
            /*
             * The current page is still a LINK rather than a disabled button:
             * pressing it reloads the page a reader is on, which is harmless
             * and is what every pager does. `aria-current` is what announces
             * it, and `variant` is what shows it.
             */
            className="num min-w-9"
          >
            <Link
              href={href(n)}
              aria-current={n === page.page ? "page" : undefined}
              /* Read by `page-swap.tsx` to paint skeleton rows on the click.
                 An attribute rather than a selector on the nav's label, which
                 would break silently the day the label is reworded. */
              data-page-link={n}
            >
              {n}
            </Link>
          </Button>
        ),
      )}
    </nav>
  );
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
      /*
       * THE HEADER'S FACTS, FOR THE PANE TO PAINT ON CLICK.
       *
       * `pane-swap.tsx` reads these off the clicked row and renders the
       * reading pane's real feed name, headline and byline in the same frame
       * as the click — about a second before the server answers. They are
       * already here as props, so skeleton bars over a headline this row is
       * displaying would have been a placeholder for something known.
       *
       * ATTRIBUTES RATHER THAN SCRAPED TEXT. The title is rendered with
       * `text-pretty` and the feed name is truncated by CSS, so reading the
       * elements' text would hand the pane whatever the layout did to it.
       * These carry the values themselves — the same seam `data-article-id`
       * already is, and the same reason the list stays a Server Component.
       *
       * THE BUTTONS' INPUTS ARE HERE TOO, which an earlier version of this
       * refused on the grounds that rendering Save before the server had
       * authorized the read would be "inventing authority on the client". That
       * was wrong, and worth recording as wrong: `toggleSaved` and
       * `toggleRead` authorize on the SERVER — `assertCan` plus the `user_id`
       * filter in every query — so a button pressed early cannot do anything
       * the reader was not already allowed to do. The client was never the
       * gate. `data-url` is the server's own value, the same one already in
       * this row's `href`, and `resolveUrl` admitted only `http:`/`https:` at
       * ingest, so it is as safe to render here as in the pane.
       */
      data-title={article.title}
      data-feed-title={feedTitle}
      data-published-at={article.publishedAt}
      data-author={article.author ?? ""}
      data-words={article.words}
      data-url={article.url}
      data-read={read ? "true" : "false"}
      data-saved={article.savedAt !== null ? "true" : "false"}
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
          <h2 className="font-display text-2xl">No such page</h2>
          {/*
           * SAYS HOW LONG THE VIEW IS NOW, which is the whole point of this
           * state after the move to numbered pages.
           *
           * The common way to arrive here is not a typo. In the Unread view
           * the set SHRINKS as you read: measured, 70 unread over two pages
           * becomes 20 unread over one as page 1 is marked read on scroll —
           * and the "2" button is still on screen from the render before. So
           * the reader presses a real button and lands on an empty screen.
           *
           * Nothing is lost: those 20 rows moved to page 1. This state has to
           * say so, or it reads as a page of articles having vanished, which
           * is the one thing §6.2 says this product cannot look like. (A
           * keyset cursor could not produce this; `types.ts` records it as the
           * cost of the reversal.)
           */}
          <p className="max-w-[46ch]">
            {state.total === 0
              ? "There is nothing in this view to page through."
              : `This view is ${state.pages} ${state.pages === 1 ? "page" : "pages"} long — ${
                  state.total
                } ${state.total === 1 ? "article" : "articles"}. It may have got shorter as you read it, or the number was edited by hand.`}
          </p>
          <Button asChild variant="outline">
            <Link href={hrefWith(params, { page: null })}>Back to page 1</Link>
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
            <PageSwap page={state.page.page}>
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
            </PageSwap>
            <div className="px-lg py-lg gap-sm grid">
              {/*
               * THE WHOLE SET, not this page's slice. It said "50 articles"
               * on every full page of a 340-article list, which told the
               * reader the size of the page they could already see and
               * nothing about the list they were in.
               */}
              <span className="text-muted num text-xs">
                {state.page.total} {state.page.total === 1 ? "article" : "articles"}
                {state.page.pages > 1 ? `, page ${state.page.page} of ${state.page.pages}` : ""}
              </span>
              <Pager page={state.page} params={params} />
            </div>
          </>
        ) : (
          <Empty state={state} params={params} />
        )}
      </div>
    </section>
  );
}
