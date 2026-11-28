import type { ListState } from "@/components/article-list";
import type { Article, Folder, ListFeed, Page } from "@/lib/types";

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
  query: string;
  unreadOnly: boolean;
  /** The feed this view is scoped to, if any. */
  currentSub: ListFeed | undefined;
  folder: Folder | undefined;
  /**
   * Only the feeds this view covers — never all of them.
   *
   * `ListFeed` AND NOT `SubscriptionWithUnread`, which is a performance fact
   * with a correctness edge. Nothing below reads an unread count or a today
   * counter; asking for the wider shape made the list pane wait ~700 ms on
   * two aggregate queries per page click. See `ListFeed` in `types.ts`.
   */
  scopedSubs: ListFeed[];
  feedTitleOf: (feedId: number) => string;
};

export function chooseListState({
  page,
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
   * Asked for a page that is not there. Checked before every "nothing to read"
   * state, because the reader asked for a SPECIFIC page and it does not exist
   * — a different fact from having read everything, and the only one true
   * here. Read off the page itself rather than a separate flag, so it cannot
   * disagree with the rows: `page > 1` and nothing on it means exactly this.
   */
  if (page.page > 1) return { kind: "past-end", pages: page.pages, total: page.total };

  if (currentSub?.status === "not_a_feed") {
    return {
      kind: "not-a-feed",
      feedTitle: feedTitleOf(currentSub.feedId),
      // The verdict's own timestamp when there is one, else the last failure:
      // §6.3's notice names when the address stopped being a feed.
      since: currentSub.notFeedAt ?? currentSub.lastErrorAt,
      lastGood: currentSub.lastSuccessAt,
    };
  }

  if (currentSub) return { kind: "feed-empty", feedTitle: feedTitleOf(currentSub.feedId) };

  if (unreadOnly) {
    // The next scheduled check, so "nothing unread" reads as a schedule rather
    // than a failure. Drawn from the SCOPED feeds; a dead or not-a-feed feed
    // has no next check and is skipped.
    const next = scopedSubs
      .filter((s) => s.nextFetchAt !== null)
      .sort((a, b) => (a.nextFetchAt! < b.nextFetchAt! ? -1 : 1))[0];
    return {
      kind: "all-read",
      nextFetch: next ? { title: feedTitleOf(next.feedId), at: next.nextFetchAt! } : null,
    };
  }

  return { kind: "feed-empty", feedTitle: folder ? folder.name : "This view" };
}
