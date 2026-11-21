import { notFound } from "next/navigation";

import { ArticleList, decodeCursor } from "@/components/article-list";
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
import { getViewer } from "@/lib/server/viewer";
import { displayFeedId } from "@/lib/article-feed";
import type { Article, Scope } from "@/lib/types";
import { strictId } from "@/lib/view-params";

/*
 * The three-pane shell, shared by `/` and `/feed/[id]`.
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
  const viewer = await getViewer();
  const account = viewer.kind === "user" ? viewer.user : null;

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

  const scope: Scope =
    feedId !== undefined
      ? { kind: "feed", feedId, unreadOnly }
      : folderId != null
        ? { kind: "folder", folderId, unreadOnly }
        : unreadOnly
          ? { kind: "unread" }
          : { kind: "all" };

  const page = await listArticles(viewer, scope, cursor, { query });

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
   * ASKED, not summed.
   *
   * Summing the sidebar's per-feed badges was correct only while an article
   * belonged to exactly one feed. Rung 2 is global, so a story carried by two
   * subscribed feeds is ONE article with TWO arrivals: each badge counts it
   * correctly and the sum counts it twice, so the header read "2 unread" above
   * a list holding one row.
   */
  const unreadCount = await countUnread(viewer, scope);

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

  const openId = strictId(params.article);
  const openArticle = openId === null ? null : await getArticle(viewer, openId);

  const title = currentSub
    ? feedTitleOf(currentSub.feedId)
    : folder
      ? folder.name
      : unreadOnly
        ? "All unread"
        : "All articles";

  return (
    <>
      <AppBar
        accountName={account?.name ?? ""}
        initials={account?.initials ?? ""}
        current="reader"
      />
      <div className="grid min-h-[calc(100dvh-var(--bar-height))] items-start md:grid-cols-[var(--side-w)_minmax(0,1fr)] lg:grid-cols-[var(--side-w)_var(--list-w)_minmax(0,1fr)]">
        <Sidebar
          folders={folders}
          subs={subs}
          currentFeedId={feedId}
          currentFolderId={folder?.id}
          scope={unreadOnly ? "unread" : "all"}
          params={params}
        />
        <ArticleList
          title={title}
          unreadCount={unreadCount}
          state={state}
          scope={scope}
          query={query}
          openArticleId={openArticle?.id ?? null}
          articleFeedTitle={articleFeedTitle}
          params={params}
        />
        <ReaderPane
          article={openArticle}
          feedTitleOf={feedTitleOf}
          articleFeedTitle={articleFeedTitle}
        />
      </div>
    </>
  );
}
