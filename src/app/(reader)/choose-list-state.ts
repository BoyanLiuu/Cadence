import type { ListState } from "@/components/article-list";
import type { Article, Cursor, Folder, Page, SubscriptionWithUnread } from "@/lib/types";

/*
 * Which of the designed empty states a list is in.
 *
 * Extracted from the route component because it is the part most likely to be
 * wrong and the hardest part to see: every branch renders a page that looks
 * finished. Two of M4's review findings were in here —
 *
 *   - an empty page reached THROUGH A CURSOR fell to the account-wide
 *     "all read" state, so paging past the end rendered "Nothing unread in any
 *     feed" under a heading saying "All unread / 81 unread";
 *   - the "next check" line was drawn from every subscription rather than the
 *     scoped ones, so the Essays view named a feed in News.
 *
 * Neither is visible in a screenshot of a working page, and neither was
 * reachable from a component test, because the choosing happened inside an
 * async Server Component. As a pure function it is just a table of cases.
 *
 * ORDER IS LOAD-BEARING: the most specific explanation wins. A `not_a_feed`
 * feed with no articles must say the address stopped being a feed, not
 * "nothing here yet" — the first tells the reader something is broken, the
 * second reads like a quiet week (§6.3).
 */

export type ChooseInput = {
  page: Page<Article>;
  /** Present when the reader paged, which changes what "empty" means. */
  cursor: Cursor | undefined;
  query: string;
  unreadOnly: boolean;
  /** The feed this view is scoped to, if any. */
  currentSub: SubscriptionWithUnread | undefined;
  folder: Folder | undefined;
  /** Only the subscriptions this view covers — never all of them. */
  scopedSubs: SubscriptionWithUnread[];
  feedTitleOf: (feedId: number) => string;
};

export function chooseListState({
  page,
  cursor,
  query,
  unreadOnly,
  currentSub,
  folder,
  scopedSubs,
  feedTitleOf,
}: ChooseInput): ListState {
  if (page.items.length > 0) return { kind: "rows", page };

  // A search that found nothing explains itself before anything else does.
  if (query !== "") return { kind: "no-matches", query };

  /*
   * Paged past the end. Checked before every "nothing to read" state, because
   * the reader asked for OLDER rows and there are none — which is a different
   * fact from having read everything, and the only one that is true here.
   */
  if (cursor) return { kind: "past-end" };

  if (currentSub?.feed.status === "not_a_feed") {
    const { feed } = currentSub;
    return {
      kind: "not-a-feed",
      feedTitle: feedTitleOf(feed.id),
      since: feed.notFeedAt ?? feed.lastError?.at ?? null,
      lastGood: feed.lastSuccessAt,
    };
  }

  if (currentSub) return { kind: "feed-empty", feedTitle: feedTitleOf(currentSub.feedId) };

  if (unreadOnly) {
    // The next scheduled check, so "nothing unread" reads as a schedule rather
    // than a failure. Drawn from the SCOPED feeds; a dead or not-a-feed feed
    // has no next check and is skipped.
    const next = scopedSubs
      .filter((s) => s.feed.nextFetchAt !== null)
      .sort((a, b) => (a.feed.nextFetchAt! < b.feed.nextFetchAt! ? -1 : 1))[0];
    return {
      kind: "all-read",
      nextFetch: next ? { title: feedTitleOf(next.feedId), at: next.feed.nextFetchAt! } : null,
    };
  }

  return { kind: "feed-empty", feedTitle: folder ? folder.name : "This view" };
}
