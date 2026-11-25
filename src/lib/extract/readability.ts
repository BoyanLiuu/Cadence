import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { ExtractStatus } from "@/lib/types";

import { sanitizeHtml, textOf } from "./sanitize";

/*
 * Pulling the article out of a page (§6.5, N5).
 *
 * PURE: HTML in, HTML out, no network and no database. The fetch is the
 * caller's job, which keeps this testable against saved pages and keeps the one
 * sanctioned way out to the internet (`ingest/fetch.ts`) as the only place that
 * dials anything.
 *
 * WHY READABILITY RATHER THAN SELECTORS. §6.5 picks it for recall, and recall
 * is the right thing to optimise when the fallback is an empty reading pane:
 * a slightly over-inclusive extraction that keeps a stray caption is readable,
 * and a precise one that returns nothing is not. Ten site-specific CSS
 * selectors beat any amount of heuristic tuning for the handful of sites that
 * matter, which is what `selectors.ts` is for and is not in this step.
 *
 * THE RESULT IS NOT TRUSTED. Readability returns a subtree of an
 * attacker-controlled document, so its output goes through `sanitizeHtml` like
 * any other third-party markup. It is a content extractor, not a security
 * boundary, and nothing about picking the right `<div>` removes an `onerror`.
 */

/**
 * §6.5's threshold. Under this many characters of text on a 200 OK is `thin`.
 *
 * Not a failure. A publisher that gates the article serves a real page with a
 * paragraph of it, which is a 200 with very little to read — and saying so is
 * more useful than an empty pane or a generic error.
 */
export const THIN_TEXT_CHARS = 600;

/**
 * Below this, there was no article — `failed`, not `thin`.
 *
 * The two degraded states make different CLAIMS. `thin` says "the publisher
 * likely gates the full text", which is a statement about the publisher, and it
 * should not be made about a response that yielded three characters: that is a
 * page we could not read, which is `failed` and tells the reader to open the
 * original rather than to believe anything about a paywall. Without this floor,
 * a body of `<<<>>>` came back as a confident `thin`.
 */
const NO_ARTICLE_CHARS = 25;

/**
 * When a feed body is too short to be the article (§6.5).
 *
 * Three signals, and the third is the one that matters: plenty of feeds send a
 * perfectly substantial first two paragraphs and then "continue reading", which
 * is long enough to pass a length test and still not the article.
 */
export function needsExtraction(contentHtml: string | null | undefined): boolean {
  if (typeof contentHtml !== "string" || contentHtml.trim() === "") return true;

  const text = textOf(contentHtml);
  if (text.length < 1200) return true;

  // The last 200 characters, because the marker is at the END of the teaser.
  const tail = text.slice(-200);
  return /…\s*$|…\s*$|read (more|the full)|continue reading/i.test(tail);
}

export type Extracted = {
  status: Extract<ExtractStatus, "ok" | "thin">;
  /** Sanitised, and resolved against the page it came from. */
  contentHtml: string;
  /** Readability's title, which is often cleaner than the feed's. */
  title: string | null;
  textLength: number;
};

export type ExtractOptions = {
  /** Where the page was SERVED from, for relative URLs and for Readability. */
  baseUrl: string;
  /** Passed through to `sanitizeHtml`; see its note on why this is injected. */
  rewriteImage?: (absolute: string) => string | null;
};

/**
 * One fetched page turned into article HTML, or `null` when there is no article.
 *
 * `null` means "Readability found nothing", which the caller records as
 * `failed` — distinct from `thin`, where it found something and there was
 * barely any of it. A reader needs those to read differently: one is "we could
 * not read the page", the other is "the publisher is holding the text back".
 */
export function extractArticleHtml(html: string, options: ExtractOptions): Extracted | null {
  if (typeof html !== "string" || html.trim() === "") return null;

  let article: ReturnType<Readability["parse"]>;
  try {
    /*
     * `url` SET, because Readability resolves relative links itself and
     * without it throws on some documents. jsdom is given the same address so
     * the two agree.
     *
     * NO `runScripts`, NO `resources`: this is an attacker-controlled page, so
     * nothing in it executes and nothing it references is loaded. Those are
     * jsdom's defaults and are stated because a later convenience that turns
     * either on would make this a browser pointed at a hostile document.
     */
    const dom = new JSDOM(html, { url: options.baseUrl });
    article = new Readability(dom.window.document).parse();
  } catch {
    /*
     * CAUGHT, because Readability runs over markup no one has validated and
     * throws on malformed input. The alternative is a 500 on a reader opening
     * an article, where the honest answer is "the full text could not be read
     * from the page" — which `extract_status='failed'` already renders.
     */
    return null;
  }

  if (article === null) return null;

  const contentHtml = sanitizeHtml(article.content ?? "", {
    baseUrl: options.baseUrl,
    rewriteImage: options.rewriteImage,
  });
  if (contentHtml === "") return null;

  /*
   * MEASURED AFTER SANITISING, not from Readability's own `textContent`.
   *
   * The two differ: the sanitiser removes elements the allowlist does not
   * permit, so a page whose "article" is mostly an embedded player or a form
   * measures long before cleaning and short after. The number that decides
   * `thin` has to be the amount of text the READER will actually get, which is
   * the text in what we are about to store.
   */
  const textLength = textOf(contentHtml).trim().length;
  if (textLength < NO_ARTICLE_CHARS) return null;

  return {
    status: textLength < THIN_TEXT_CHARS ? "thin" : "ok",
    contentHtml,
    title: article.title?.trim() || null,
    textLength,
  };
}
