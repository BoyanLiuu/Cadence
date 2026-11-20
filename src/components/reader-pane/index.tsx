import { Bookmark, ExternalLink, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NORM_VERSION } from "@/lib/ingest/canonical-url";
import { joinSetAside, redlineUrl } from "@/lib/ingest/url-redline";
import { otherFeedCount, type Article } from "@/lib/types";

/*
 * The reading pane.
 *
 * THE READING PANE DOES NOT ANIMATE (Appendix E). Its only job is to be read,
 * and text that fades in is text you cannot start reading yet. No Motion
 * imports belong in this file.
 */

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** Roughly 200 words a minute, floored at one. */
const readingMinutes = (words: number) => Math.max(1, Math.round(words / 200));

/**
 * The arrivals proof: every address this article came in under, collapsing to
 * one key.
 *
 * The design's signature element, and the screen a reader consults when they
 * doubt the unread count — so the redlines are COMPUTED from the same rules
 * `canonicalUrl` applies rather than written out. See `url-redline.ts`.
 */
function ArrivalsProof({
  article,
  feedTitleOf,
}: {
  article: Article;
  feedTitleOf: (id: number) => string;
}) {
  if (!article.arrivals || article.arrivals.length < 2) return null;

  const others = otherFeedCount(article);
  /*
   * The key can be null — `canonicalUrl` refuses an address it cannot key.
   * Rendering it unguarded under the claim "The same key N times" would print
   * an empty line where the proof should be, on the one screen a reader opens
   * when they doubt the count. Fall back to the address, as the footer does.
   */
  const key = redlineUrl(article.arrivals[0].url).key ?? article.arrivals[0].url;

  return (
    <details open className="my-xs px-lg pt-md pb-lg bg-paper-hi shadow-[var(--shadow-sheet)]">
      <summary className="gap-xs text-ink flex cursor-pointer list-none items-center text-sm font-medium">
        Also in {others} {others === 1 ? "feed" : "feeds"}: one row, {article.arrivals.length}{" "}
        arrivals
      </summary>

      <ol
        aria-label="Every address this article arrived under"
        className="mt-md border-ink m-0 grid list-none border-t p-0"
      >
        {article.arrivals.map((arrival) => {
          const redline = redlineUrl(arrival.url);
          return (
            <li
              key={`${arrival.feedId}-${arrival.url}`}
              className="border-rule pl-xl py-sm gap-3xs before:bg-accent after:bg-accent relative grid border-b before:absolute before:top-[1.85rem] before:left-0 before:h-px before:w-md before:content-[''] after:absolute after:inset-y-0 after:left-0 after:w-px after:content-['']"
            >
              <p className="gap-sm num flex flex-wrap justify-between text-sm">
                <span className="text-ink font-medium">{feedTitleOf(arrival.feedId)}</span>
                <span className="text-muted">
                  Arrived {stamp(arrival.at)}
                  {arrival.how === "first" ? ", first: this row" : ", matched by address"}
                </span>
              </p>
              <p className="text-sm break-words">
                {redline.parts.map((part, i) =>
                  part.kept ? (
                    <span key={i}>{part.text}</span>
                  ) : (
                    <del key={i} className="text-muted decoration-accent line-through decoration-2">
                      {part.text}
                    </del>
                  ),
                )}
              </p>
              {redline.setAside.length > 0 && (
                <p className="text-muted text-xs font-medium">
                  Set aside: {joinSetAside(redline.setAside)}
                </p>
              )}
            </li>
          );
        })}

        <li className="pl-xl py-sm gap-3xs before:bg-accent after:bg-accent relative grid before:absolute before:top-[1.85rem] before:left-0 before:h-px before:w-lg before:content-[''] after:absolute after:top-0 after:left-0 after:h-[1.85rem] after:w-px after:content-['']">
          <p className="gap-sm num flex flex-wrap justify-between text-sm">
            <span className="text-ink font-medium">Address key</span>
            <span className="text-muted">rules v{NORM_VERSION}</span>
          </p>
          <p className="text-ink text-sm font-medium break-words">{key}</p>
          <p className="text-muted text-xs font-medium">
            The same key {article.arrivals.length} times, so one row and one unread.
          </p>
        </li>
      </ol>
    </details>
  );
}

/** The revision redline: what changed, with read state untouched (§6.2). */
function RevisionNote({ article }: { article: Article }) {
  if (!article.revisedAt) return null;

  return (
    <div className="px-lg py-md bg-paper-2">
      <p className="text-ink text-sm font-medium">
        Revised {stamp(article.revisedAt)}
        {article.wasReadAt ? " · returned to unread, because this feed asks for that" : ""}
      </p>
      {article.revision && (
        <p className="mt-sm text-ink-2 max-w-[66ch] leading-[1.7]">
          {article.revision.map((span, i) =>
            typeof span === "string" ? (
              <span key={i}>{span}</span>
            ) : "del" in span ? (
              <del key={i} className="text-muted decoration-accent line-through decoration-2">
                {span.del}
              </del>
            ) : (
              <ins
                key={i}
                className="text-ink decoration-accent underline decoration-2 underline-offset-[0.22em]"
              >
                {span.ins}
              </ins>
            ),
          )}
        </p>
      )}
      <p className="mt-xs text-muted text-sm">
        {article.wasReadAt
          ? `You had read it at ${stamp(article.wasReadAt)}.`
          : "It stayed read: an edit is not a re-publication."}
      </p>
    </div>
  );
}

/** The honest degraded states for a teaser feed (§6.5). */
function ExtractNote({ article }: { article: Article }) {
  const copy: Partial<Record<Article["extractStatus"], string>> = {
    thin: "The publisher likely gates the full text. This is what the feed sent.",
    blocked: "The publisher's host refused the fetch. This is what the feed sent.",
    failed: "The full text could not be read from the page. This is what the feed sent.",
    none: "This feed sends a summary. Open it to fetch the full text.",
  };
  const text = copy[article.extractStatus];
  if (!text) return null;

  return (
    <div className="border-rule bg-paper-hi px-lg py-md text-ink-2 border text-sm">
      {text}
      {article.extractStatus === "none" && (
        <>
          {" "}
          <span className="text-muted">
            Nothing was sent: <code className="text-xs">POST /api/articles/:id/extract</code>{" "}
            arrives in M13.
          </span>
        </>
      )}
    </div>
  );
}

export function ReaderPane({
  article,
  feedTitleOf,
}: {
  article: Article | null;
  feedTitleOf: (feedId: number) => string;
}) {
  if (!article) {
    return (
      <div className="px-2xl pt-xl pb-3xl hidden min-w-0 lg:block">
        <div className="gap-xs text-ink-2 grid min-h-[60%] place-content-center text-center">
          <p>Nothing open.</p>
          <p className="text-muted text-sm">Show all articles to read older ones.</p>
        </div>
      </div>
    );
  }

  return (
    <article className="px-2xl pt-xl pb-3xl sticky top-[var(--bar-height)] hidden h-[calc(100dvh-var(--bar-height))] min-w-0 overflow-y-auto lg:block">
      <div className="gap-md grid max-w-[44rem]">
        <p className="text-sm font-medium">{feedTitleOf(article.feedId)}</p>
        <h1 className="text-5xl leading-[1.02]">{article.title}</h1>

        <p className="gap-2xs gap-x-md text-ink-2 num flex flex-wrap text-sm">
          <span>
            {article.author ? `By ${article.author}, ` : ""}published {stamp(article.publishedAt)}
          </span>
          <span className="text-muted">{readingMinutes(article.words)} min read</span>
        </p>

        <div className="gap-xs pb-md border-rule flex flex-wrap border-b">
          <Button variant="outline" size="sm">
            <Bookmark aria-hidden="true" />
            {article.savedAt ? "Saved" : "Save"}
          </Button>
          <Button variant="outline" size="sm">
            <Square aria-hidden="true" />
            {article.readAt ? "Mark unread" : "Mark read"}
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={article.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open original
            </a>
          </Button>
        </div>

        <ArrivalsProof article={article} feedTitleOf={feedTitleOf} />
        <RevisionNote article={article} />
        <ExtractNote article={article} />

        <div className="gap-md text-ink-2 grid text-[length:var(--text-read)] leading-[1.7]">
          {article.body.map((block, i) => {
            if ("h" in block) {
              return (
                <h3 key={i} className="mt-sm text-xl">
                  {block.h}
                </h3>
              );
            }
            if ("li" in block) {
              return (
                <ul key={i} className="gap-2xs pl-lg m-0 grid max-w-[66ch] list-disc">
                  {block.li.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={i} className="max-w-[66ch]">
                {block.p}
              </p>
            );
          })}
        </div>

        <p className="pt-md border-rule text-muted border-t text-sm">
          From{" "}
          <a href={article.url} target="_blank" rel="noopener noreferrer" className="break-words">
            {redlineUrl(article.url).key ?? article.url}
          </a>
        </p>
      </div>
    </article>
  );
}
