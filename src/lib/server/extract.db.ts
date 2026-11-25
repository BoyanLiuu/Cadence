import { prisma } from "@/lib/db/client";
import { extractArticleHtml, needsExtraction } from "@/lib/extract/readability";
import { fetchFeed } from "@/lib/ingest/fetch";
import { decode } from "@/lib/ingest/sniff";
import { recordUrl } from "@/lib/ingest/article-urls";
import { articleUrlHash } from "@/lib/ingest/dedupe";
import type { Extraction } from "@/lib/types";

import { reachableArticles } from "./read-state.db";

/*
 * On-open full text (§6.5, N5).
 *
 * ONE PAGE LOAD PER ARTICLE A PERSON ASKED FOR, cached forever. §6.5 is built
 * on this number: extracting at ingest would be an `[assumed]` 300 feeds × 30
 * items/day = 9 000 unrequested page loads a day, which is the line between a
 * reader and a crawler. On-demand is one person opening one article, which is
 * conventionally fine — so "cached forever" is not an optimisation here, it is
 * the entire justification for being allowed to fetch at all.
 *
 * THE SECOND-ORDER FETCH, AGAIN. The address comes from a feed, not from the
 * reader, so it is third-party input in exactly the way discovery's hrefs are:
 * a feed can publish `<link>http://169.254.169.254/latest/meta-data/</link>`
 * and this code will dial it from inside its own network on the first click.
 * It goes through `fetchFeed`, which guards the address and re-guards every
 * redirect hop — the same single sanctioned exit `one-fetch-path.test.ts`
 * enforces. There is no second fetch path here and must not be.
 *
 * AUTHORIZED THROUGH `reachableArticles`, the filter read state and saving
 * already use rather than a third copy. Articles are global rows (Appendix B)
 * so an id is just a number, RLS is bypassed by the owning role, and that
 * filter IS the authorization model. Without it, `extractArticle(7)` is an
 * arbitrary-URL fetcher pointed at any address in the whole corpus.
 *
 * WRITES NOTHING PER-READER. `articles` is shared, so an extraction one reader
 * pays for serves everyone who follows that feed — which is the same economy
 * as one fetch serving ten subscribers (§6.1).
 */

/** An article that cannot be reached, or is not an id at all. */
export class ArticleNotExtractable extends Error {
  constructor(readonly articleId: number) {
    super("That article is not in any feed you follow.");
    this.name = "ArticleNotExtractable";
  }
}

const toExtraction = (row: {
  id: bigint;
  extractStatus: Extraction["status"];
  extractedHtml: string | null;
  extractFinalUrl: string | null;
}): Extraction => ({
  articleId: Number(row.id),
  status: row.extractStatus,
  contentHtml: row.extractedHtml,
  finalUrl: row.extractFinalUrl,
});

/**
 * Reads the full text off the article's page, once (§6.5).
 *
 * `fetcher` is injected for the same reason `fetchFeed` injects its validator:
 * the tests need to exercise this without the open web, and keeping ONE code
 * path means what they exercise is the production path. Production takes the
 * default.
 */
export async function applyExtraction(
  userId: string,
  articleId: number,
  fetcher: typeof fetchFeed = fetchFeed,
): Promise<Extraction> {
  if (!Number.isSafeInteger(articleId) || articleId <= 0) {
    throw new ArticleNotExtractable(articleId);
  }

  const id = BigInt(articleId);
  const reachable = await reachableArticles(userId, [id]);
  if (reachable.length === 0) throw new ArticleNotExtractable(articleId);

  const article = await prisma.article.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      url: true,
      contentHtml: true,
      extractStatus: true,
      extractedHtml: true,
      extractFinalUrl: true,
      /*
       * THE FEEDS THAT DELIVERED IT, not `articles.feed_id`.
       *
       * Rung 2 is GLOBAL, so an article is owned by whichever feed carried it
       * first and may reach this reader through an entirely different one. The
       * owning feed's subscription row was read, which for a cross-feed
       * arrival does not exist for this reader — so `subscriptions[0]` was
       * undefined, the mode silently defaulted to `on_demand`, and a reader
       * who had set `off` on the feed they actually follow got the fetch
       * anyway. `article_feeds` is the relation the lists and
       * `reachableArticles` both use, and this has to agree with them.
       */
      arrivals: {
        select: {
          feed: {
            select: { subscriptions: { where: { userId }, select: { fullTextMode: true } } },
          },
        },
      },
    },
  });

  /*
   * ALREADY DECIDED, SO NO REQUEST. This is the "cached forever" half, and it
   * covers every terminal state rather than only the successful one: a `thin`
   * or `blocked` article re-fetched on every open is precisely the repeated
   * unrequested traffic the on-open rule exists to avoid, and it would hammer
   * the publishers least willing to be read.
   *
   * A retry therefore needs a deliberate mechanism — `extracted_at` is stored
   * so one can be written later — and not the absence of this check.
   */
  if (article.extractStatus !== "none") return toExtraction(article);

  /*
   * `off` MEANS OFF, checked before the fetch rather than after.
   *
   * It is per-subscription, so this reads the asking reader's own setting: one
   * reader opting out of extraction for a feed must not stop another from
   * getting it, and the result lands on the shared `articles` row either way.
   */
  /*
   * `off` WINS ONLY IF EVERY delivering subscription says so. A reader
   * following two feeds that both carry a story, with extraction off on one,
   * has still asked for full text somewhere — and the result lands on the
   * shared `articles` row either way, so the restrictive reading would let one
   * subscription veto a preference expressed on another.
   */
  const modes = article.arrivals
    .flatMap((arrival) => arrival.feed.subscriptions)
    .map((subscription) => subscription.fullTextMode);
  if (modes.length > 0 && modes.every((mode) => mode === "off")) return toExtraction(article);

  /*
   * NOTHING TO DO FOR A COMPLETE BODY. The feed already sent the article, so
   * fetching the page would be an outbound request for text we hold — the
   * expensive direction to be wrong in, and the one `needsExtraction` exists
   * to prevent.
   */
  if (!needsExtraction(article.contentHtml)) return toExtraction(article);

  /*
   * CLAIMED ATOMICALLY BEFORE THE FETCH. Everything above is a read, so two
   * opens arriving together both saw `extract_status = 'none'` and both dialled
   * the publisher — a check-then-act race on the one rule the whole feature
   * rests on, and the shape this project has avoided everywhere else by
   * letting a constraint decide (§6.1: never check-then-insert).
   *
   * `extracted_at IS NULL` is the condition and the column is the claim, so no
   * enum value had to be invented for "in progress". A caller that does not win
   * the claim does not wait: it answers with what is stored, which is either a
   * finished extraction or the teaser, and the winner's `revalidatePath` brings
   * the text to both.
   */
  const claimed = await prisma.$executeRaw`
    UPDATE cadence.articles SET extracted_at = now()
    WHERE id = ${id} AND extracted_at IS NULL
  `;
  if (claimed === 0) return toExtraction(article);

  const outcome = await fetcher(article.url);

  /*
   * A REFUSED OR FAILED FETCH IS A RECORDED STATE, not an exception. The
   * reader opened an article; the honest answer is one of §6.5's degraded
   * states with its own copy, and recording it also stops the next open
   * retrying — which is what makes a dead publisher cost one request rather
   * than one per open forever.
   *
   * `blocked` is specifically a CDN challenge: a 403 means the host decided
   * not to serve us, which is different from a timeout and different again
   * from a page we could not parse. The reader's next action differs for each.
   */
  if (outcome.kind !== "changed") {
    /*
     * A TRANSIENT FAILURE IS NOT RECORDED, so the next open may try again.
     *
     * Everything here is written once and never retried, which is the rule
     * that makes extraction defensible — and applied to a 429 or a 503 it
     * marks an article permanently unreadable because the publisher was busy
     * for one second. Those are the two outcomes that explicitly mean "later".
     *
     * The permanent ones still stick: a 401 or 403 is a host deciding not to
     * serve us (`blocked`), a 404 or 410 is an article that is gone, and
     * re-asking on every open would be exactly the repeated unrequested
     * traffic §6.5 forbids — aimed, as ever, at the hosts least willing to
     * receive it.
     *
     * The claim is RELEASED on the transient path, or the retry it exists to
     * allow could never happen.
     */
    const status = outcome.status;
    const transient =
      outcome.kind === "failed" &&
      (status === null || status === 429 || (status >= 500 && status <= 599));

    if (transient) {
      await release(id);
      return { articleId, status: "none", contentHtml: null, finalUrl: null };
    }

    const permanent = status === 401 || status === 403 ? "blocked" : "failed";
    return write(id, { status: permanent, contentHtml: null, finalUrl: null });
  }

  /*
   * DECODED BY THE DECLARED CHARSET, through the same function the feed path
   * uses. A hardcoded UTF-8 read turned every windows-1252 and ISO-8859-1 page
   * into mojibake — and because extraction is never retried, that would be
   * stored PERMANENTLY. `sniff.ts` already handles the BOM, the Content-Type
   * and the meta charset; a second decoder here would be a second set of
   * answers to a question already settled (§6.3).
   */
  const html = decode(outcome.body, outcome.contentType ?? undefined).text;
  const extracted = extractArticleHtml(html, { baseUrl: outcome.landedUrl });

  if (extracted === null) {
    // Readability found no article. Distinct from `thin`, where it found one
    // and there was barely any of it — `thin` claims the publisher is holding
    // text back, which must not be said about a page we could not read.
    return write(id, { status: "failed", contentHtml: null, finalUrl: outcome.landedUrl });
  }

  return write(
    id,
    {
      status: extracted.status,
      contentHtml: extracted.contentHtml,
      finalUrl: outcome.landedUrl,
    },
    extracted.textLength,
  );
}

/**
 * Gives up a claim, so a transient failure can be retried on the next open.
 *
 * Only ever called where NO status was written. Releasing a claim on a row
 * that has a terminal status would reopen it to re-fetching forever, which is
 * the opposite of what the claim is for.
 */
async function release(id: bigint): Promise<void> {
  await prisma.article.update({ where: { id }, data: { extractedAt: null } });
}

/** Stores one extraction, and appends where it landed to `article_urls`. */
async function write(
  id: bigint,
  result: { status: Extraction["status"]; contentHtml: string | null; finalUrl: string | null },
  textLength?: number,
): Promise<Extraction> {
  const row = await prisma.article.update({
    where: { id },
    data: {
      extractStatus: result.status,
      extractedHtml: result.contentHtml,
      extractFinalUrl: result.finalUrl,
      extractedAt: new Date(),
      /*
       * `text_len` is updated ONLY on a successful extraction, and only
       * upward-in-truth: it feeds the reading-time estimate, and after
       * extraction the honest number is the length of what the reader can now
       * read. A failed or thin extraction leaves the feed's own measurement
       * alone rather than replacing it with a smaller, less useful one.
       */
      ...(result.status === "ok" && textLength !== undefined ? { textLen: textLength } : {}),
    },
    select: {
      id: true,
      extractStatus: true,
      extractedHtml: true,
      extractFinalUrl: true,
    },
  });

  if (result.finalUrl !== null) await rememberFinalUrl(id, result.finalUrl);

  return toExtraction(row);
}

/**
 * Appends the resolved address to `article_urls`, closing the shortener gap.
 *
 * §6.1: ingestion never follows a redirect to canonicalise, because one HTTP
 * request per item turns a 40-item poll into 40 requests against a publisher we
 * are trying to be polite to. So a `t.co` link is stored as itself, and the
 * first extraction is when we learn where it really goes. Appending that is
 * what makes a later feed carrying the real address resolve to THIS row rather
 * than inserting a second one.
 *
 * THROUGH `recordUrl`, not a raw insert of its own. That function already
 * handles the race with `ON CONFLICT ... DO NOTHING`, already distinguishes
 * `recorded` from `known` from `conflict`, and already refuses to REPOINT an
 * address held by another article — which would silently move it and change
 * which row a reader's history refers to. A second insert here would be a
 * second place for that policy to be decided, and it would have got the
 * conflict case wrong by treating it as success.
 */
async function rememberFinalUrl(articleId: bigint, finalUrl: string): Promise<void> {
  const urlHash = articleUrlHash(finalUrl);
  // Unkeyable addresses are dropped rather than stored under an invented hash.
  // Extraction succeeded either way; only the shortener gap stays open.
  if (urlHash === null) return;

  const result = await recordUrl(articleId, urlHash, finalUrl);

  /*
   * A CONFLICT IS LOGGED, NOT THROWN. The extraction itself worked and the
   * reader is about to read it — failing the open because two articles claim
   * one address would be the wrong trade. It means the canonical form of where
   * this page landed already belongs to another row, which is the genuine
   * duplicate-pair conflict §6.1 names and the manual merge was going to be
   * for. Left in place and visible rather than stolen.
   */
  if (result.kind === "conflict") {
    console.warn(
      `[extract] ${finalUrl} is already held by article ${result.heldBy}; not repointed from ${articleId}`,
    );
  }
}
