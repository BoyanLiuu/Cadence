import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { Folder, SubscriptionWithUnread } from "@/lib/types";
import { READER_PATH } from "@/lib/routes";
import { pathWith, type ReaderParams } from "@/lib/view-params";

/*
 * The sidebar: folders, feeds, derived counts, and the inline warning for a
 * feed that needs attention.
 *
 * THE SIDEBAR NEVER HOLDS A NUMBER THE SERVICE DID NOT COMPUTE. Every count
 * here arrives on the `SubscriptionWithUnread` rows; nothing is summed, cached
 * or adjusted locally. §6.2 makes the unread count a query precisely so there
 * is one place it can be wrong, and a component that adds up its own totals
 * quietly becomes a second place.
 *
 * The "needs attention" lines are not decoration either. §6.4: a dead feed is
 * surfaced to the reader with its error history, because retrying forever in
 * silence is how a reader accumulates invisible rot.
 */

/** The copy for a feed that is not simply working, or null if it is. */
function troubleOf(sub: SubscriptionWithUnread): string | null {
  const { feed } = sub;
  const day = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        })
      : "";

  switch (feed.status) {
    case "not_a_feed":
      return `Not a feed since ${day(feed.notFeedAt ?? feed.lastError?.at)}`;
    case "dead": {
      const code =
        typeof feed.lastError?.code === "number" ? `all ${feed.lastError.code}s` : "no answer";
      return `Stopped ${day(feed.deadAt)}, ${code}`;
    }
    case "backoff":
      return `Retrying, ${feed.consecutiveFailures} failures`;
    default:
      return null;
  }
}

export function feedsNeedingAttention(subs: SubscriptionWithUnread[]): SubscriptionWithUnread[] {
  return subs.filter((s) => troubleOf(s) !== null);
}

function FeedRow({
  sub,
  current,
  params,
}: {
  sub: SubscriptionWithUnread;
  current: boolean;
  params: ReaderParams;
}) {
  const trouble = troubleOf(sub);
  return (
    <li>
      <Link
        // Carries the Unread/All choice and the search term across, but not
        // the page cursor or the open article — both belong to the old list.
        href={pathWith(`/feed/${sub.feedId}`, params)}
        aria-current={current ? "page" : undefined}
        className="gap-sm px-sm py-xs text-ink-2 hover:bg-paper-3 hover:text-ink aria-[current]:bg-paper-hi aria-[current]:text-ink grid grid-cols-[minmax(0,1fr)_auto] items-baseline rounded-[2px] text-sm no-underline transition-colors"
      >
        <span className="truncate">{sub.customTitle ?? sub.feed.title}</span>
        {/* No zero. An unread count of nothing is better said by absence. */}
        {sub.unread > 0 && <span className="num text-ink font-medium">{sub.unread}</span>}
        {trouble && (
          <span className="gap-2xs text-ink-2 mt-3xs col-span-full flex items-center text-xs">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {trouble}
          </span>
        )}
      </Link>
    </li>
  );
}

export function Sidebar({
  folders,
  subs,
  currentFeedId,
  currentFolderId,
  scope,
  params,
}: {
  folders: Folder[];
  subs: SubscriptionWithUnread[];
  currentFeedId?: number;
  currentFolderId?: number;
  scope: "unread" | "all" | "saved";
  params: ReaderParams;
}) {
  const totalUnread = subs.reduce((n, s) => n + s.unread, 0);
  const attention = feedsNeedingAttention(subs);

  // Feeds with no folder still have to appear, or a subscription can be
  // invisible — which reads as data loss rather than as a filing gap.
  const unfiled = subs.filter((s) => s.folderId === null);

  return (
    <nav
      aria-label="Feeds"
      className="px-sm pt-md border-rule bg-paper-2 sticky top-[var(--bar-height)] hidden h-[calc(100dvh-var(--bar-height))] overflow-y-auto border-r md:block"
    >
      <div className="gap-md grid">
        <Link
          /*
           * Resets the scope to unread, because that is what the label says.
           * Carrying the current scope meant that from "All articles" this
           * link led to `/?scope=all` — a page headed "All articles" — while
           * still being marked as the current "All unread".
           */
          href={pathWith(READER_PATH, params, { folder: null, scope: "unread" })}
          aria-current={
            !currentFeedId && params.folder === undefined && scope === "unread" ? "page" : undefined
          }
          className="gap-sm px-sm py-xs text-ink hover:bg-paper-3 aria-[current]:bg-paper-hi grid grid-cols-[minmax(0,1fr)_auto] items-baseline rounded-[2px] font-medium no-underline transition-colors"
        >
          <span className="truncate">All unread</span>
          {totalUnread > 0 && <span className="num font-medium">{totalUnread}</span>}
        </Link>

        {folders.map((folder) => {
          const inFolder = subs.filter((s) => s.folderId === folder.id);
          if (inFolder.length === 0) return null;
          const folderUnread = inFolder.reduce((n, s) => n + s.unread, 0);
          return (
            <div key={folder.id}>
              <Link
                href={pathWith(READER_PATH, params, { folder: String(folder.id) })}
                // Without this, nothing in the sidebar is marked current on a
                // folder view — the reader cannot see where they are.
                aria-current={currentFolderId === folder.id ? "page" : undefined}
                className="gap-sm px-sm py-xs mb-3xs border-rule text-ink pb-xs aria-[current]:bg-paper-hi grid grid-cols-[minmax(0,1fr)_auto] items-baseline rounded-t-[2px] border-b font-medium no-underline"
              >
                <span className="truncate">{folder.name}</span>
                {folderUnread > 0 && <span className="num font-medium">{folderUnread}</span>}
              </Link>
              <ul className="grid list-none p-0">
                {inFolder.map((sub) => (
                  <FeedRow
                    key={sub.feedId}
                    sub={sub}
                    current={sub.feedId === currentFeedId}
                    params={params}
                  />
                ))}
              </ul>
            </div>
          );
        })}

        {unfiled.length > 0 && (
          <div>
            <p className="px-sm py-xs text-ink border-rule mb-3xs pb-xs border-b font-medium">
              Unfiled
            </p>
            <ul className="grid list-none p-0">
              {unfiled.map((sub) => (
                <FeedRow
                  key={sub.feedId}
                  sub={sub}
                  current={sub.feedId === currentFeedId}
                  params={params}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {/*
       * RENDERED ONLY WHEN IT HAS SOMETHING TO SAY.
       *
       * It used to hold two links and was always drawn. With "Keyboard
       * shortcuts" removed, the attention line is the only thing left in it —
       * and an unconditional sticky bar with a top rule and this much padding
       * is a visible empty strip across the bottom of the sidebar on the
       * common case, which is a reader whose feeds are all fine.
       *
       * The bottom padding is load-bearing when it IS drawn: the bar is
       * sticky, so without it the last feed rows scroll underneath and are
       * unreachable.
       */}
      {attention.length > 0 && (
        <div className="gap-xs mt-xl -mx-sm px-lg pt-md border-rule bg-paper-2 sticky bottom-0 grid justify-items-start border-t pb-[calc(var(--spacing-2xl)+var(--spacing-md))] text-sm">
          <Link href="/settings/feeds" className="text-ink-2 hover:text-ink">
            {attention.length} {attention.length === 1 ? "feed needs" : "feeds need"} attention
          </Link>
        </div>
      )}
    </nav>
  );
}
