import Link from "next/link";

import { AppBar } from "@/components/app-bar";
import { listArticles, listSubscriptions } from "@/lib/server/article-service";
import { getViewer } from "@/lib/server/viewer";
import { firstParam } from "@/lib/view-params";
import type { Article, Cursor } from "@/lib/types";

import { SavedEmpty, SavedFilterEmpty } from "./empty";

/*
 * `GET /saved` — the saved surface.
 *
 * ITS OWN VIEW, NOT A FILTER ON THE UNREAD RIVER. The plan takes this from
 * Readwise Reader, which gets it right: saving is a different intention from
 * reading, so the surface is a different shape. No sidebar, no three panes, no
 * unread counts — a full-width table ordered by when you saved it, which is
 * the only order that matters here.
 *
 * Building it as `?scope=saved` on the reader would have been less code and
 * the wrong product: the reader's whole frame is about what is NEW, and
 * nothing in Saved is.
 */

const DATE = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const readingMinutes = (words: number) => Math.max(1, Math.round(words / 200));

type Filter = "all" | "unread" | "read";

function matches(article: Article, filter: Filter): boolean {
  if (filter === "unread") return article.readAt === null;
  if (filter === "read") return article.readAt !== null;
  return true;
}

export default async function SavedPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string | string[] }>;
}) {
  const viewer = await getViewer();
  const account = viewer.kind === "user" ? viewer.user : null;

  /*
   * EVERY saved article, not one page of them.
   *
   * The headline count, all three tab counts and the list itself are derived
   * from this, so taking a single 50-row page would report "50 articles" to a
   * reader with 300 and leave the rest unreachable — there is no pagination
   * control on this surface. Saved sets are small by nature, but a count that
   * silently caps is the same class of lie as a stale unread count.
   */
  const subs = await listSubscriptions(viewer);
  const all: Article[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await listArticles(viewer, { kind: "saved" }, cursor);
    all.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor);

  const { show } = await searchParams;
  const requested = firstParam(show);
  const filter: Filter = requested === "unread" || requested === "read" ? requested : "all";

  // Newest save first. The reader's own ordering is by publication, which is
  // the wrong axis here: you want what you put aside most recently.
  const saved = all.sort((a, b) => (a.savedAt! < b.savedAt! ? 1 : -1));
  const shown = saved.filter((a) => matches(a, filter));

  const unreadCount = saved.filter((a) => a.readAt === null).length;
  const readCount = saved.length - unreadCount;
  const feedTitleOf = (id: number) => {
    const sub = subs.find((s) => s.feedId === id);
    return sub ? (sub.customTitle ?? sub.feed.title) : "Unknown feed";
  };

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: saved.length },
    { key: "unread", label: "Unread", count: unreadCount },
    { key: "read", label: "Read", count: readCount },
  ];

  return (
    <>
      <AppBar
        accountName={account?.name ?? ""}
        initials={account?.initials ?? ""}
        current="saved"
      />

      <main className="px-lg py-xl gap-lg mx-auto grid max-w-[1180px]">
        <header className="gap-xs grid">
          <h1>Saved for later</h1>
          <p className="text-muted num text-sm">
            {saved.length} {saved.length === 1 ? "article" : "articles"}
            {saved.length > 0 ? `, ${unreadCount} unread` : ""}
          </p>
        </header>

        {saved.length === 0 ? (
          <SavedEmpty />
        ) : (
          <>
            <div className="inline-flex justify-self-start">
              {tabs.map((tab, i) => (
                <Link
                  key={tab.key}
                  href={tab.key === "all" ? "/saved" : `/saved?show=${tab.key}`}
                  aria-current={filter === tab.key ? "true" : undefined}
                  className={`border-muted bg-paper-hi text-ink-2 px-sm gap-2xs aria-[current]:border-ink aria-[current]:bg-ink aria-[current]:text-paper hover:bg-paper-2 inline-flex min-h-8 items-center border font-medium no-underline transition-colors ${
                    i === 0 ? "rounded-l-[2px]" : "-ml-px"
                  } ${i === tabs.length - 1 ? "rounded-r-[2px]" : ""}`}
                >
                  {tab.label} <span className="num">{tab.count}</span>
                </Link>
              ))}
            </div>

            {shown.length === 0 ? (
              <SavedFilterEmpty
                filter={filter === "read" ? "read" : "unread"}
                total={saved.length}
              />
            ) : (
              <ul className="border-ink m-0 grid list-none border-t p-0">
                {shown.map((article) => (
                  <li key={article.id} className="border-rule border-b">
                    <Link
                      href={`/?article=${article.id}`}
                      className="gap-sm px-sm py-md hover:bg-paper-2 grid items-baseline no-underline transition-colors md:grid-cols-[minmax(0,1fr)_14rem_7rem_5rem_5rem]"
                    >
                      <span className="font-display text-ink text-xl text-pretty">
                        {article.title}
                      </span>
                      <span className="text-ink-2 text-sm">
                        {feedTitleOf(article.feedId)}
                        {article.author ? `, ${article.author}` : ""}
                      </span>
                      <span className="text-ink-2 num text-sm">Saved {DATE(article.savedAt!)}</span>
                      <span className="text-ink-2 num text-sm">
                        {readingMinutes(article.words)} min
                      </span>
                      <span className="text-ink-2 text-sm">
                        {article.readAt === null ? "Unread" : "Read"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </>
  );
}
