import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ArticleList, decodeCursor } from "@/components/article-list";
import { ArticleListSkeleton } from "@/components/article-list/skeleton";
import { AppBar } from "@/components/app-bar";
import { ReaderPane } from "@/components/reader-pane";

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

  const [subs, folders] = await Promise.all([listSubscriptions(viewer), listFolders(viewer)]);

  /*
   * An id nobody is subscribed to is a 404, not an empty reader.
   *
   * Falling through used to render the global `all-read` state with the
   * ACCOUNT-WIDE unread total under a feed heading — `/feed/9999` showed
   * "All unread / 81 unread" above "Nothing unread in any feed". That is not
   * an empty view, it is a wrong one, and it is indistinguishable from an
   * unsubscribe having silently emptied a real feed.
   */
  if (feedId !== undefined && !subs.some((s) => s.feedId === feedId)) notFound();

  // Normalised once, in a pure function that tests can reach. See
  // `normalise-params.ts` for the two bugs that justify it being separate.
  const params = normaliseParams(searchParams);
  const query = params.q ?? "";

  const unreadOnly = params.scope !== "all";
  const cursor = decodeCursor(params.before);
  // Strict, like the feed id: `?folder=2abc` is a wrong URL, not folder 2.
  const folderId = params.folder !== undefined ? strictId(params.folder) : undefined;
  if (params.folder !== undefined && folderId === null) notFound();
  // An unknown folder is also a 404, for the same reason an unknown feed is.
  if (folderId != null && !folders.some((f) => f.id === folderId)) notFound();

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
   * THREE INDEPENDENT READS, ONE ROUND TRIP OF WAITING.
   *
   * These were three separate `await`s spread down the file — the list here,
   * the unread count a dozen lines below it, the open article at the bottom —
   * and nothing between them used the one before. Against a REMOTE Postgres
   * that is three sequential round trips where one would do, and it is most of
   * why clicking a folder in the sidebar felt like a click that had not
   * registered: ~350 ms, of which two thirds was waiting in a queue of our own
   * making.
   *
   * They are genuinely independent. `scope` comes from the search params and
   * the folder list; `cursor` and `query` from the params; `openId` from
   * `?article=`. None of them is derived from another's result, which is
   * exactly why the sequence was invisible — each `await` read naturally where
   * it sat.
   *
   * `getArticle` RESOLVES TO NULL WITHOUT A QUERY when nothing is open, so the
   * common case still issues two.
   */
  /*
   * THE OPEN ARTICLE ONLY. The list and its count moved into `ListPane` below
   * so a keyed `<Suspense>` can show a skeleton while they load — see the note
   * there. This one stays here because both the list and the reading pane need
   * its id, and because the reading pane is not what a sidebar click changes.
   */
  const openArticle = openId === null ? null : await getArticle(viewer, openId);

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
  /*
   * ASKED, not summed — and asked in the `Promise.all` above.
   *
   * Summing the sidebar's per-feed badges was correct only while an article
   * belonged to exactly one feed. Rung 2 is global, so a story carried by two
   * subscribed feeds is ONE article with TWO arrivals: each badge counts it
   * correctly and the sum counts it twice, so the header read "2 unread" above
   * a list holding one row.
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

  return (
    <>
      <AppBar accountName={account.name} initials={account.initials} current="reader" />
      <div className="grid min-h-[calc(100dvh-var(--bar-height))] items-start md:grid-cols-[var(--side-w)_minmax(0,1fr)] lg:grid-cols-[var(--side-w)_var(--list-w)_minmax(0,1fr)]">
        <Sidebar
          folders={folders}
          subs={subs}
          currentFeedId={feedId}
          currentFolderId={folder?.id}
          scope={unreadOnly ? "unread" : "all"}
          params={params}
        />
        {/*
         * KEYED ON THE SCOPE, which is what makes the skeleton appear at all.
         *
         * A folder navigates by SEARCH PARAM — `/reader?folder=2` — and Next
         * does not remount a route segment for that, so `loading.tsx` never
         * fires and an unkeyed `<Suspense>` has nothing to re-suspend: React
         * keeps the resolved children on screen while the new ones load,
         * which is exactly the "nothing happened" this is fixing.
         *
         * Changing the key throws the old subtree away, so the fallback shows
         * immediately and the new pane streams in behind it. The sidebar and
         * the reading pane are outside the boundary and do not move.
         *
         * The cursor and the query are in the key as well as the scope: paging
         * and searching are the same wait for the same reason.
         */}
        <Suspense
          key={`${JSON.stringify(scope)}|${params.before ?? ""}|${query}`}
          fallback={<ArticleListSkeleton />}
        >
          <ListPane
            viewer={viewer}
            scope={scope}
            cursor={cursor}
            query={query}
            title={title}
            unreadOnly={unreadOnly}
            currentSub={currentSub}
            folder={folder}
            scopedSubs={scopedSubs}
            feedTitleOf={feedTitleOf}
            articleFeedTitle={articleFeedTitle}
            openArticleId={openArticle?.id ?? null}
            params={params}
          />
        </Suspense>
        <ReaderPane
          article={openArticle}
          feedTitleOf={feedTitleOf}
          articleFeedTitle={articleFeedTitle}
        />
      </div>
    </>
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
 * ITS TWO READS STILL RUN TOGETHER. They were parallelised earlier for the same
 * latency — the rows and the count are independent, and the count is what the
 * header prints — so the `Promise.all` moved here with them rather than being
 * unpicked.
 */
async function ListPane({
  viewer,
  scope,
  cursor,
  query,
  title,
  unreadOnly,
  currentSub,
  folder,
  scopedSubs,
  feedTitleOf,
  articleFeedTitle,
  openArticleId,
  params,
}: {
  viewer: Awaited<ReturnType<typeof requireViewer>>;
  scope: Scope;
  cursor: ReturnType<typeof decodeCursor>;
  query: string;
  title: string;
  unreadOnly: boolean;
  currentSub: Parameters<typeof chooseListState>[0]["currentSub"];
  folder: Parameters<typeof chooseListState>[0]["folder"];
  scopedSubs: Parameters<typeof chooseListState>[0]["scopedSubs"];
  feedTitleOf: (id: number) => string;
  articleFeedTitle: (a: Pick<Article, "feedId" | "arrivals">) => string;
  openArticleId: number | null;
  params: ReaderParams;
}) {
  const [page, unreadCount] = await Promise.all([
    listArticles(viewer, scope, cursor, { query }),
    /*
     * ASKED, not summed.
     *
     * Summing the sidebar's per-feed badges was correct only while an article
     * belonged to exactly one feed. Rung 2 is global, so a story carried by two
     * subscribed feeds is ONE article with TWO arrivals: each badge counts it
     * correctly and the sum counts it twice, so the header read "2 unread"
     * above a list holding one row.
     */
    countUnread(viewer, scope),
  ]);

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
