/*
 * Making a body readable, in two stages that run at different times.
 *
 * §6.3: a bare `&`, a stray control character or three unclosed tags fail the
 * WHOLE poll — not one item. The feed goes quiet and the reader cannot tell
 * breakage from silence.
 *
 * The two stages exist because the corpus proved they are not the same job:
 *
 *   `sanitize()` runs on EVERY body, before the first parse attempt. It strips
 *   a BOM and the control characters XML 1.0 forbids. These are never
 *   meaningful content, and `20-c0-control-chars.xml` showed why the timing
 *   matters: fast-xml-parser happily ACCEPTS a 0x08 mid-title and carries it
 *   into the data, where it corrupts the rendered title and — worse — feeds a
 *   junk byte into rung 3's `content_hash`, so the same article hashes
 *   differently depending on a byte nobody can see.
 *
 *   `repair()` runs ONCE, only after a parse has already failed. It guesses:
 *   escaping an ampersand or closing a tag changes the document's structure,
 *   so it must not run on a body that parsed cleanly.
 *
 * Neither stage touches well-formed input, but only `sanitize` is cheap enough
 * in risk to run unconditionally.
 */

/** The tags publishers most often leave open. Order matters: innermost first. */
const COMMONLY_UNCLOSED = [
  "title",
  "link",
  "description",
  "language",
  "copyright",
  "author",
  "category",
  "comments",
  "guid",
  "pubDate",
  "lastBuildDate",
  "generator",
  "docs",
  "ttl",
  "name",
  "url",
  "width",
  "height",
];

/**
 * Splits text into alternating outside/inside-CDATA runs.
 *
 * Every transform that rewrites markup has to skip CDATA, because the whole
 * point of a CDATA section is that its contents are NOT markup. `&` and `<`
 * inside one are already legal and already mean themselves.
 */
function mapOutsideCdata(xml: string, fn: (chunk: string) => string): string {
  const parts = xml.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
}

/**
 * Escapes a bare `&` — one not already starting a character reference.
 *
 * The negative lookahead is the first trick: `&amp;`, `&#8230;` and `&hellip;`
 * are left alone, while `Ledger & Lathe` and `?a=1&b=2` are repaired. Escaping
 * unconditionally would double-escape every entity in the document and turn
 * every `&amp;` into a literal `&amp;amp;` on screen.
 *
 * Skipping CDATA is the second. `Smith & Sons` inside `<![CDATA[…]]>` is
 * already valid, and "repairing" it puts a literal `&amp;` into the article
 * body — visible to the reader, and baked into the content hash.
 */
export function escapeBareAmpersands(xml: string): string {
  return mapOutsideCdata(xml, (chunk) =>
    chunk.replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;"),
  );
}

/**
 * Strips the control characters XML 1.0 forbids outright.
 *
 * Tab, newline and carriage return are legal and are kept. Everything else
 * below 0x20, plus the lone 0x7f, is illegal and makes a conforming parser
 * reject the document — which costs the whole poll for one stray byte.
 */
export function stripControlChars(xml: string): string {
  return xml.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Removes a BOM the decoder left at the start of the text. */
export function stripBom(xml: string): string {
  return xml.replace(/^﻿/, "");
}

/**
 * Closes the common unclosed tags.
 *
 * Three guards, and every one of them was earned by a bug this function had:
 *
 *  1. BALANCE FIRST. A tag whose opens and closes already match is left
 *     entirely alone. Without this, `<description>A teaser with <em>markup</em>
 *     …</description>` gets closed at the `<em`, orphaning the rest — so a feed
 *     whose only real defect was `<language>en` came back with EVERY
 *     description empty. The repair pass must never touch a tag that is fine.
 *  2. NEVER MATCH A SELF-CLOSING TAG. `<link rel="alternate" href="…"/>` is
 *     complete. Rewriting it to `…/></link>` makes an Atom feed that failed the
 *     first attempt strictly less parseable than before the "repair".
 *  3. TEXT ONLY. The content between the open tag and the next `<` must contain
 *     no markup, which is the shape of the real pathology:
 *     `<title>Saltmarsh Almanac\n    <link>`.
 *
 * It does not attempt to balance the document in general. That is a tag-soup
 * parser's job, and a wrong guess here silently moves text between fields,
 * which is worse than a failed poll because it looks like success.
 */
export function closeUnclosedTags(xml: string): string {
  return mapOutsideCdata(xml, (chunk) => {
    let out = chunk;
    for (const tag of COMMONLY_UNCLOSED) {
      // Count real opens (not self-closing) against closes. Only an imbalance
      // means something is actually unclosed.
      const opens = (out.match(new RegExp(`<${tag}(\\s[^>]*?)?(?<!/)>`, "gi")) ?? []).length;
      const closes = (out.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length;
      if (opens <= closes) continue;

      let remaining = opens - closes;
      const re = new RegExp(`<${tag}(\\s[^>]*?)?(?<!/)>([^<]*?)(?=<(?!/${tag}\\s*>))`, "gi");
      out = out.replace(re, (match, attrs: string | undefined, text: string) => {
        if (remaining <= 0) return match;
        remaining -= 1;
        return `<${tag}${attrs ?? ""}>${text}</${tag}>`;
      });
    }
    return out;
  });
}

/**
 * Always-safe cleanup, run before the first parse attempt.
 *
 * A BOM and the C0 controls are never content. Removing them cannot change what
 * a document means, so there is no reason to wait for a failure — and waiting
 * is what let control characters reach article titles.
 */
export function sanitize(xml: string): string {
  return stripControlChars(stripBom(xml));
}

/**
 * The one repair pass, run only after a parse has failed.
 *
 * These two transforms GUESS at the author's intent, which is why they are
 * gated behind a failure. Order is load-bearing: tag closing goes last, because
 * it matches on `<` boundaries the ampersand escape can create.
 */
export function repair(xml: string): string {
  return closeUnclosedTags(escapeBareAmpersands(xml));
}

/**
 * Both stages, for the retry path.
 *
 * @deprecated Prefer `sanitize` before the first attempt and `repair` after a
 * failure. Kept because §6.3 names a single "pre-clean" step and a reader
 * coming from the architecture will look for it.
 */
export function preclean(xml: string): string {
  return repair(sanitize(xml));
}
