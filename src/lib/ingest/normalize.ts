import type { RawItem } from "@/lib/types";

/*
 * The last step before identity: resolve addresses, and drop what cannot be
 * identified at all.
 *
 * Two jobs, both from §6.3:
 *
 *  1. RELATIVE URL RESOLUTION, against an ordered base chain. An item linking
 *     `/post/4` with no base leaves every link in the reader broken.
 *  2. DROP AND COUNT an item with no guid, no url and no title. Synthesising
 *     identity from an array position is the one choice that GUARANTEES
 *     duplicates — the position changes on the next poll, so the same item
 *     gets a new id and inserts again, forever.
 */

/**
 * Where to resolve a relative URL against, in §6.3's order:
 * `xml:base`, then the feed's `<link rel="alternate">`, then the feed URL.
 *
 * The feed URL is last and is always present, so the chain never runs dry.
 */
export type BaseChain = {
  xmlBase?: string | null;
  siteUrl?: string | null;
  feedUrl: string;
};

export type NormalizeResult = {
  items: RawItem[];
  /**
   * Items dropped for having no identity. Counted rather than silently
   * discarded, because this number belongs in `fetch_log` — a feed that starts
   * dropping every item looks identical to a feed that went quiet (§6.3).
   */
  droppedNoIdentity: number;
};

/** The first base that is an absolute URL. */
function resolveBase(chain: BaseChain): string {
  for (const candidate of [chain.xmlBase, chain.siteUrl, chain.feedUrl]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).toString();
    } catch {
      // Not absolute, so it cannot be a base. Try the next link.
    }
  }
  return chain.feedUrl;
}

/**
 * Narrows the feed's base by an item's own `xml:base`, if it declares one.
 *
 * `xml:base` NESTS, and an item's value is usually relative — `xml:base="2026/"`
 * inside a feed based at `/essays/` means `/essays/2026/`. So the item's base is
 * itself resolved against the feed's before anything resolves against it.
 *
 * A declared base that will not resolve is ignored rather than fatal: falling
 * back to the feed's base gives a usable link, where failing gives none.
 */
function effectiveChain(chain: BaseChain, itemXmlBase: string | null): BaseChain {
  if (itemXmlBase === null || itemXmlBase.trim() === "") return chain;
  try {
    return { ...chain, xmlBase: new URL(itemXmlBase.trim(), resolveBase(chain)).toString() };
  } catch {
    return chain;
  }
}

/**
 * The only schemes an article URL may have.
 *
 * Feed content is REMOTE USER INPUT. This value ends up in an `href` the reader
 * clicks and in the image proxy's input, so `javascript:`, `data:` and `file:`
 * have to be refused here — at the boundary where untrusted bytes become
 * application data — rather than at each of the places that later render it.
 * `new URL()` resolves them perfectly happily; it is a parser, not a filter.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Resolves one possibly-relative URL.
 *
 * Returns null rather than a guess when resolution fails or the scheme is not
 * allowed: a missing link the reader can see is better than a plausible wrong
 * one it cannot, and far better than an executable one.
 */
export function resolveUrl(url: string | null, chain: BaseChain): string | null {
  if (url === null || url.trim() === "") return null;
  const trimmed = url.trim();
  try {
    const resolved = new URL(trimmed, resolveBase(chain));
    if (!ALLOWED_SCHEMES.has(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * True when an item carries nothing any rung of the ladder could key on.
 *
 * Title alone IS identity enough — rung 3 hashes the normalised title with the
 * first 500 characters of text, so a titled item with no guid and no url still
 * resolves. Only an item with none of the three is unidentifiable.
 */
function hasNoIdentity(item: RawItem): boolean {
  const has = (v: string | null) => v !== null && v.trim() !== "";
  return !has(item.guid) && !has(item.url) && !has(item.title);
}

/** Collapses runs of whitespace, so a reflowed title is not a new title. */
function tidyText(value: string | null): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/**
 * Normalises a parsed feed's items.
 *
 * Pure: no I/O, no clock, no network. §6.1 is explicit that identity must never
 * be resolved by following a redirect at ingest — that is one HTTP request per
 * item, which turns a 40-item poll into 40 requests against a publisher you
 * were trying to be polite to. Shortened URLs are resolved lazily, by the first
 * extraction (§6.5).
 */
export function normalize(items: RawItem[], chain: BaseChain): NormalizeResult {
  const out: RawItem[] = [];
  let droppedNoIdentity = 0;

  for (const item of items) {
    // The item's own base narrows the feed's, per item, before its URL resolves.
    const itemChain = effectiveChain(chain, item.xmlBase);
    const normalized: RawItem = {
      guid: tidyText(item.guid),
      url: resolveUrl(item.url, itemChain),
      title: tidyText(item.title),
      author: tidyText(item.author),
      publishedAt: item.publishedAt,
      contentHtml: item.contentHtml,
      summaryHtml: item.summaryHtml,
      // Resolution is done; carrying the base further would invite a second,
      // inconsistent resolution downstream.
      xmlBase: null,
    };

    if (hasNoIdentity(normalized)) {
      droppedNoIdentity += 1;
      continue;
    }
    out.push(normalized);
  }

  return { items: out, droppedNoIdentity };
}
