import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ArticleList, decodeCursor } from "@/components/article-list";
import { ArticleListSkeleton } from "@/components/article-list/skeleton";
import { AppBar } from "@/components/app-bar";
import { ReaderPane } from "@/components/reader-pane";
import { PaneSwap } from "@/components/reader-pane/pane-swap";
import { ReaderPaneSkeleton } from "@/components/reader-pane/skeleton";
import { SidebarSkeleton } from "@/components/sidebar/skeleton";

import { chooseListState } from "./choose-list-state";
import { normaliseParams, type RawReaderParams } from "./normalise-params";
import { Sidebar } from "@/components/sidebar";
import {
  countUnread,
  getArticle,
  listArticles,
  listFolders,
  listSubscriptions,
} from "@/lib/server/article-service";
import { requireViewer } from "@/lib/server/viewer";
import { displayFeedId } from "@/lib/article-feed";
import type { Article, Scope } from "@/lib/types";
import { strictId, type ReaderParams } from "@/lib/view-params";

/*
 * The three-pane shell, shared by `/reader` and `/feed/[id]`.
 *
 * One component for both routes because they ARE the same screen with a
 * different scope — the prototype draws them identically. Splitting them would
 * mean two places to keep the sidebar, the toggle and the pagination in step.
 *
 * Everything is read through M1's service layer, whose signatures do not change
 * when M6 puts Postgres behind them. This file is the first consumer of it.
 */

/**
 * The reader's whole view, carried in the URL. See `lib/view-params.ts`.
 *
 * Every value may arrive as an ARRAY, because `?q=a&q=b` is a URL anyone can
 * send. Normalised with `firstParam` before use — reading `.trim()` off the
 * raw value answered 500.
 */
export type ReaderSearchParams = RawReaderParams;

export async function ReaderView({
  searchParams,
  feedId,
}: {
  searchParams: ReaderSearchParams;
  feedId?: number;
}) {
  // Resolved once per request and passed down, never read again further in (§3).
  const viewer = await requireViewer();
  // `requireViewer()` redirected an anon away, so this is always a reader.
  const account = viewer.user;

  // Normalised once, in a pure function that tests can reach. See
  // `normalise-params.ts` for the two bugs that justify it being separate.
  const params = normaliseParams(searchParams);
  const query = params.q ?? "";

  const unreadOnly = params.scope !== "all";
  const cursor = decodeCursor(params.before);
  // Strict, like the feed id: `?folder=2abc` is a wrong URL, not folder 2.
  const folderId = params.folder !== undefined ? strictId(params.folder) : undefined;
  /*
   * THE MALFORMED-URL 404s STAY HERE, where they cost nothing: `?folder=2abc`
   * is answerable from the string alone. The EXISTENCE checks — a feed or
   * folder that parses but is nobody's — moved into `readerShell` below,
   * because they need the subscription list and nothing else on this screen
   * should wait on it. See the note on that function.
   */
  if (params.folder !== undefined && folderId === null) notFound();

  const openId = strictId(params.article);

  /*
   * `saved` IS A READING CONTEXT, NOT A SURFACE — and the distinction is the
   * whole reason for `openId !== null` below.
   *
   * `{ kind: "saved" }` has been in the `Scope` union and supported by
   * `listArticles` and `countUnread` since M7 — the parity suite covers it —
   * and nothing ever produced one. So `/saved` linked a row to `?article=<id>`
   * and opened that article in the ALL UNREAD list: everything on the saved
   * shelf is read, so the row being opened was not in the list beside it. The
   * reading pane was right and its context was somebody else's.
   *
   * WHY IT NEEDS AN ARTICLE. `saved/page.tsx` records a decision this would
   * otherwise contradict: the saved SURFACE is its own full-width table, "not
   * a filter on the unread river", because the reader's frame is about what is
   * NEW and nothing in Saved is. Honouring `?scope=saved` on its own would
   * make exactly that rejected product reachable at `/reader?scope=saved`.
   *
   * With an article it is a different claim: you came from the shelf to read
   * one piece, and the list beside it should be the set you came from, so the
   * next and previous rows are the other things you saved. The surface stays
   * at `/saved`; only the reading context follows you.
   */
  const scope: Scope =
    feedId !== undefined
      ? { kind: "feed", feedId, unreadOnly }
      : folderId != null
        ? { kind: "folder", folderId, unreadOnly }
        : params.scope === "saved" && openId !== null
          ? { kind: "saved" }
          : unreadOnly
            ? { kind: "unread" }
            : { kind: "all" };

  /*
   * STARTED, NOT AWAITED — and that one word is what this whole screen's
   * responsiveness turns on.
   *
   * `readerShell` is the expensive read: `listSubscriptions` alone is ~600 ms
   * against the remote pooler, the slowest query in the project, because it
   * carries every feed's unread count and today's counters. It used to be
   * awaited HERE, before anything rendered — so every click in the reader,
   * including opening an article, blocked the entire tree on it. React holds a
   * resolved tree on screen while the next one renders, so what a reader saw
   * was ~900 ms of the PREVIOUS article under their click, then a swap.
   *
   * Holding the promise instead lets this function return immediately. The
   * three panes below each `await` it inside their OWN `<Suspense>`, so each
   * one decides for itself whether to show a placeholder or hold still:
   *
   *   the sidebar     unkeyed — holds its old content, never flickers
   *   the list        keyed on the scope — skeleton when the scope changes
   *   the reading pane keyed on the article — skeleton on every open
   *
   * ONE PROMISE, AWAITED THREE TIMES. A promise can be awaited by any number
   * of consumers and runs once, so this is still one set of queries per
   * request — which is why it is passed down rather than each pane calling
   * `readerShell` itself. `cache()` would also dedupe, but only on argument
   * identity, and these arguments are rebuilt on every render.
   */
  const shell = readerShell(viewer, { feedId, folderId });

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} current="reader" />
      <div className="grid min-h-[calc(100dvh-var(--bar-height))] items-start md:grid-cols-[var(--side-w)_minmax(0,1fr)] lg:grid-cols-[var(--side-w)_var(--list-w)_minmax(0,1fr)]">
        {/*
         * UNKEYED, DELIBERATELY — the opposite of the two boundaries below.
         *
         * With no key there is nothing to re-suspend on, so React keeps the
         * resolved sidebar on screen while the new one loads and the reader
         * never sees it blink. That is the point: the sidebar is identical on
         * every screen in the reader, and the list skeleton's own note says
         * the sidebar staying still is what makes the rest read as a pane
         * loading rather than the page jumping. `SidebarSkeleton` is therefore
         * only ever seen on a first paint.
         */}
        <Suspense fallback={<SidebarSkeleton />}>
          <SidebarPane shell={shell} params={params} unreadOnly={unreadOnly} feedId={feedId} />
        </Suspense>
        {/*
         * KEYED ON THE SCOPE — and the key does LESS than this comment used to
         * claim, which is worth correcting in place rather than quietly.
         *
         * It said: "a folder navigates by search param, `loading.tsx` never
         * fires, so changing the key throws the old subtree away and the
         * fallback shows immediately". The first half is true. The last clause
         * is not, and it was never measured. Recorded here from a browser,
         * with a `MutationObserver` watching every change:
         *
         *   /reader -> /feed/1   a ROUTE change    skeleton at 86-133 ms  ✓
         *   ?folder=2            a SEARCH PARAM    no skeleton, 926 ms
         *
         * React will not replace content that is already on screen with a
         * fallback during a transition, and Next wraps a search-param
         * navigation in one. A new key remounts the boundary but buys no
         * exception: React waits for the content instead.
         *
         * SO WHAT THIS BOUNDARY IS ACTUALLY FOR is the first paint and route
         * changes — `/reader` <-> `/feed/1`, which is how a feed is opened from
         * the sidebar — and there it is worth having and now fires in ~100 ms
         * rather than ~1080 ms, because nothing upstream blocks it any more.
         *
         * A FOLDER CLICK STILL HAS NO PLACEHOLDER. The reading pane solved the
         * same problem with client-owned state in `pane-swap.tsx`; the list has
         * not been given the equivalent. Named rather than left as a surprise.
         *
         * The cursor and the query are in the key as well as the scope: paging
         * and searching are the same wait for the same reason.
         */}
        <Suspense
          key={`${JSON.stringify(scope)}|${params.before ?? ""}|${query}`}
          fallback={<ArticleListSkeleton />}
        >
          <ListPane
            shell={shell}
            viewer={viewer}
            scope={scope}
            cursor={cursor}
            query={query}
            unreadOnly={unreadOnly}
            /*
             * THE ID FROM THE URL, not from the loaded article — which it was,
             * and could no longer be once the article moved behind its own
             * boundary. The two agree whenever the article exists; when it
             * does not, this is an id matching no row, so the list highlights
             * nothing and `ScrollOpenIntoView` finds nothing to scroll to.
             * That is what it did before as well, by a longer route.
             */
            openArticleId={openId}
            params={params}
          />
        </Suspense>
        {/*
         * KEYED ON THE OPEN ARTICLE, which is the fix for "I clicked and it
         * showed me the last one for a second".
         *
         * Same mechanism as the list: `?article=123` is a search-param
         * navigation, so the route segment is not remounted, `loading.tsx`
         * never fires, and an unkeyed boundary would keep the previous
         * article's text on screen for the whole round trip. A new key throws
         * that subtree away, so the skeleton is on screen in the same frame as
         * the click and the article streams in behind it.
         *
         * `"none"` for nothing open, so closing an article also re-suspends
         * rather than holding the piece that was just closed.
         */}
        <Suspense key={openId ?? "none"} fallback={<ReaderPaneSkeleton />}>
          <ReadingPane shell={shell} viewer={viewer} openId={openId} />
        </Suspense>
      </div>
    </>
  );
}

type Viewer = Awaited<ReturnType<typeof requireViewer>>;

/**
 * Everything on this screen that needs the subscription list, read once.
 *
 * WHY IT IS ONE FUNCTION AND NOT THREE READS. The sidebar, the list's empty
 * states and the reading pane's byline all need `subs`, and all three now live
 * behind separate `<Suspense>` boundaries — so without a single shared promise
 * each boundary would issue its own copy of the project's most expensive query.
 * The parent starts this once and hands the same promise to all three.
 *
 * THE DERIVATIONS COME WITH THE DATA, for the same reason: `feedTitleOf`,
 * `articleFeedTitle`, the title and `scopedSubs` were computed in the parent
 * from `subs`, and three panes each deriving their own copy is three places for
 * the rung-2 labelling rule to drift. They are returned here so there is still
 * exactly one definition of each.
 */
async function readerShell(
  viewer: Viewer,
  { feedId, folderId }: { feedId?: number; folderId?: number | null },
) {
  const [subs, folders] = await Promise.all([listSubscriptions(viewer), listFolders(viewer)]);

  /*
   * An id nobody is subscribed to is a 404, not an empty reader.
   *
   * Falling through used to render the global `all-read` state with the
   * ACCOUNT-WIDE unread total under a feed heading — `/feed/9999` showed
   * "All unread / 81 unread" above "Nothing unread in any feed". That is not
   * an empty view, it is a wrong one, and it is indistinguishable from an
   * unsubscribe having silently emptied a real feed.
   *
   * CALLED IN HERE NOW, which is a real consequence of moving the read behind
   * a boundary: the shell paints before this runs, so a bad id shows the
   * reader's frame for a moment and then the 404 page. That is the cost of not
   * blocking every good URL on this check, and a URL nobody can reach by
   * clicking is the right place to pay it.
   */
  if (feedId !== undefined && !subs.some((s) => s.feedId === feedId)) notFound();
  // An unknown folder is also a 404, for the same reason an unknown feed is.
  if (folderId != null && !folders.some((f) => f.id === folderId)) notFound();

  const subOf = (id: number) => subs.find((s) => s.feedId === id);
  const feedTitleOf = (id: number) => {
    const sub = subOf(id);
    return sub ? (sub.customTitle ?? sub.feed.title) : "Unknown feed";
  };
  /*
   * An ARTICLE's label, which is not the same as its owning feed's.
   *
   * Rung 2 is global, so a row can be in this reader's list because a feed
   * they follow delivered it while `articles.feed_id` names a feed they do
   * not. Labelling from `feed_id` rendered "Unknown feed" on a row they were
   * looking at. See `lib/article-feed.ts`.
   */
  const isSubscribed = (id: number) => subOf(id) !== undefined;
  const articleFeedTitle = (a: Pick<Article, "feedId" | "arrivals">) =>
    feedTitleOf(displayFeedId(a, isSubscribed));

  const currentSub = feedId !== undefined ? subOf(feedId) : undefined;
  const folder = folderId != null ? folders.find((f) => f.id === folderId) : undefined;

  const scopedSubs = currentSub
    ? [currentSub]
    : folder
      ? subs.filter((s) => s.folderId === folder.id)
      : subs;

  return { subs, folders, feedTitleOf, articleFeedTitle, currentSub, folder, scopedSubs };
}

type Shell = Promise<Awaited<ReturnType<typeof readerShell>>>;

/** The sidebar, awaiting the shell so its boundary has something to wait on. */
async function SidebarPane({
  shell,
  params,
  unreadOnly,
  feedId,
}: {
  shell: Shell;
  params: ReaderParams;
  unreadOnly: boolean;
  feedId?: number;
}) {
  const { subs, folders, folder } = await shell;
  return (
    <Sidebar
      folders={folders}
      subs={subs}
      currentFeedId={feedId}
      currentFolderId={folder?.id}
      scope={unreadOnly ? "unread" : "all"}
      params={params}
    />
  );
}

/*
 * The list pane, fetching its own rows so the boundary above has something to
 * wait on.
 *
 * THIS IS THE WHOLE REASON IT IS A SEPARATE COMPONENT. A `<Suspense>` only
 * shows its fallback while a CHILD is suspended — and a child suspends by
 * awaiting. While the list's data was awaited in the parent, nothing inside the
 * boundary ever suspended: the parent simply took 220 ms longer to render and
 * the reader watched an unchanged screen.
 *
 * ITS READS STILL RUN TOGETHER, and now the shell runs with them. The rows, the
 * count and the subscription list are mutually independent — the first two come
 * from `scope`, which the parent derives from the URL alone — so all three are
 * in one `Promise.all` rather than the list waiting on the sidebar's query.
 */
async function ListPane({
  shell,
  viewer,
  scope,
  cursor,
  query,
  unreadOnly,
  openArticleId,
  params,
}: {
  shell: Shell;
  viewer: Viewer;
  scope: Scope;
  cursor: ReturnType<typeof decodeCursor>;
  query: string;
  unreadOnly: boolean;
  openArticleId: number | null;
  params: ReaderParams;
}) {
  const [{ feedTitleOf, articleFeedTitle, currentSub, folder, scopedSubs }, page, unreadCount] =
    await Promise.all([
      shell,
      listArticles(viewer, scope, cursor, { query }),
      /*
       * ASKED, not summed.
       *
       * Summing the sidebar's per-feed badges was correct only while an article
       * belonged to exactly one feed. Rung 2 is global, so a story carried by
       * two subscribed feeds is ONE article with TWO arrivals: each badge
       * counts it correctly and the sum counts it twice, so the header read
       * "2 unread" above a list holding one row.
       */
      countUnread(viewer, scope),
    ]);

  /*
   * THE HEADING, derived here because it needs both halves: the scope comes
   * from the URL and the feed's or folder's NAME comes from the shell.
   */
  const title = currentSub
    ? feedTitleOf(currentSub.feedId)
    : folder
      ? folder.name
      : scope.kind === "saved"
        ? "Saved for later"
        : unreadOnly
          ? "All unread"
          : "All articles";

  const state = chooseListState({
    page,
    cursor,
    query,
    unreadOnly,
    currentSub,
    folder,
    scopedSubs,
    feedTitleOf,
  });

  return (
    <ArticleList
      title={title}
      unreadCount={unreadCount}
      state={state}
      scope={scope}
      query={query}
      openArticleId={openArticleId}
      articleFeedTitle={articleFeedTitle}
      params={params}
    />
  );
}

/*
 * The reading pane, fetching its own article.
 *
 * THE ARTICLE AND THE SHELL IN PARALLEL. `getArticle` needs only the id from
 * the URL and the pane's byline needs only the shell, so waiting for one before
 * starting the other would add a round trip to the thing this whole change
 * exists to make feel immediate.
 *
 * `getArticle` RESOLVES TO NULL WITHOUT A QUERY when nothing is open, so the
 * empty pane costs nothing — but it still awaits the shell, which is why
 * closing an article shows the skeleton briefly rather than nothing at all.
 */
async function ReadingPane({
  shell,
  viewer,
  openId,
}: {
  shell: Shell;
  viewer: Viewer;
  openId: number | null;
}) {
  const [{ feedTitleOf, articleFeedTitle }, article] = await Promise.all([
    shell,
    openId === null ? null : getArticle(viewer, openId),
  ]);

  return (
    /*
     * WRAPPED, because the `<Suspense>` above only fires on a ROUTE change.
     * `PaneSwap` owns the pending state for a `?article=` click, which React
     * refuses to show a fallback for — measured, and written down in that
     * file. The boundary above still earns its place for `/reader` <->
     * `/feed/1` and for the first paint.
     */
    <PaneSwap articleId={article?.id ?? null}>
      <ReaderPane article={article} feedTitleOf={feedTitleOf} articleFeedTitle={articleFeedTitle} />
    </PaneSwap>
  );
}
