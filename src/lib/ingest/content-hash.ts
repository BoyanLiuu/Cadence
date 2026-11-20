import { createHash } from "node:crypto";

/*
 * Rung 3 of the ladder: the last chance to recognise an article whose guid AND
 * url both changed in one build.
 *
 * The other file where a bug is silent and permanent (Appendix F), and the one
 * with the sharper trade-off:
 *
 *   - Too UNSTABLE and the hash moves when the text did not — a re-indented
 *     template or a switched entity encoding re-publishes an entire archive as
 *     new, and every article the reader had finished comes back unread.
 *   - Too STABLE and two genuinely different articles hash alike. §6.1 is
 *     explicit that this is the WORSE failure, which is why rung 3 is hash
 *     EQUALITY and never similarity: near-duplicate titles are a clustering
 *     problem, grouped and never merged, and that is P2.
 *
 * So normalisation removes only what is provably not content — markup,
 * entity spelling, whitespace runs, Unicode composition — and nothing else.
 */

/** Characters of body text that feed the hash, per §6.1. */
export const CONTENT_HASH_PREFIX_CHARS = 500;

/**
 * The version of rung 3's normalisation, with the same contract as
 * `NORM_VERSION` for rung 2.
 *
 * Rung 3 needs its own version for the same reason rung 2 does, and the
 * omission was a real gap: changing `NAMED_ENTITIES` or `stripTags` changes
 * every digest this function will ever produce, invalidating every stored
 * `content_hash`. Unversioned, that happens with nothing failing and no record
 * of which ruleset produced which row.
 *
 * `norm-version.test.ts` fingerprints this module too, so a change here fails
 * the build.
 */
export const CONTENT_HASH_VERSION = 1;

/**
 * The named entities worth decoding.
 *
 * Deliberately short. These are the ones feeds actually emit, and the numeric
 * forms below cover everything else. A full HTML entity table would be a
 * dependency and a surface for disagreement between this and the extractor —
 * and an entity nobody emits cannot cause a hash to move.
 */
const NAMED_ENTITIES: Record<string, string> = {
  // CASE-SENSITIVE, because named character references are. `&Eacute;` is É
  // and `&eacute;` is é — different characters, not two spellings of one.
  // Lower-casing the lookup made `CAF&Eacute;` hash as `CAFé`, a different
  // word and a wrong digest. The all-caps aliases below are the ones HTML
  // genuinely defines as legacy duplicates; the rest are exact.
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  Egrave: "È",
  agrave: "à",
  Agrave: "À",
  ccedil: "ç",
  Ccedil: "Ç",
  uuml: "ü",
  Uuml: "Ü",
  ouml: "ö",
  Ouml: "Ö",
  auml: "ä",
  Auml: "Ä",
  szlig: "ß",
  copy: "©",
  COPY: "©",
  reg: "®",
  REG: "®",
  trade: "™",
  pound: "£",
  euro: "€",
  deg: "°",
  middot: "·",
  bull: "•",
  prime: "′",
  Prime: "″",
};

/** Decodes numeric and the common named character references. */
function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const codePoint =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Reject surrogates and out-of-range values rather than throwing.
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return whole;
      return String.fromCodePoint(codePoint);
    }
    // Exact match only. See the table's comment: these are case-sensitive.
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

/**
 * Removes tags, leaving their text.
 *
 * Run BEFORE entity decoding, and the order is load-bearing: decoding first
 * would turn `&lt;script&gt;` into `<script>`, which this would then strip —
 * silently deleting text the author wrote about markup.
 *
 * A block-level tag becomes a space rather than nothing, so `<p>one</p><p>two</p>`
 * does not hash as `onetwo` and collide with an article whose text really is
 * `onetwo`.
 */
function stripTags(value: string): string {
  return (
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Declarations and processing instructions.
      .replace(/<[!?][^>]*>/g, " ")
      /*
       * Only something that actually LOOKS like a tag: `<` or `</` followed by
       * a letter. A bare `<` in prose is not markup.
       *
       * The previous rule was `/<[^>]*>/g`, which ate everything between a `<`
       * and the next `>`. That turned "5 < 6 and the vote was 7 > 8" into
       * "5  8" — and "…was 9 > 8" into "5  8" as well, so two different
       * articles hashed identically and rung 3 merged them. This is the
       * "too loose" failure §6.1 names as the worse one, and post-parse text is
       * exactly where it bites: XML decoding has already turned the author's
       * `&lt;` into a real `<` by the time the text reaches here.
       */
      .replace(/<\/?[A-Za-z][^>]*>/g, " ")
  );
}

/**
 * The normal form both hash inputs share.
 *
 * Every step removes something that can change without the content changing:
 *
 *  - NFC first, so `é` composed and `e` + combining acute are one string. A
 *    CMS migration that changes Unicode composition is invisible to a reader
 *    and would otherwise re-publish every accented title.
 *  - tags, then entities, in that order (see `stripTags`).
 *  - whitespace runs collapsed, so re-indenting a template is a no-op. This is
 *    also what makes attribute reordering irrelevant: the attributes are gone
 *    with the tags, and what is left is spacing.
 */
function normalizeText(value: string): string {
  return (
    decodeEntities(stripTags(value.normalize("NFC")))
      /*
       * Control characters are stripped AFTER decoding, not before.
       *
       * M2's `sanitize` removes literal C0 bytes from a body before it is
       * parsed, so the comment on `contentHash` used to claim a NUL could not
       * reach here. It could: `&#0;` is an entity, it survives `sanitize`
       * untouched, and it decodes to a literal NUL right here — which then
       * forged the separator, so ("a&#0;b","c") and ("a","b&#0;c") shared a
       * digest. Exactly the collision the separator exists to prevent.
       */
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The title, in the form the hash uses.
 *
 * Lower-cased, unlike a canonical URL's path. A title is prose, and a
 * publisher restyling a headline from title case to sentence case has not
 * written a new article. The collision risk that creates is acceptable because
 * rung 3 requires the title AND the first 500 characters of text to match.
 */
export function normalizeTitle(title: string | null | undefined): string {
  return typeof title === "string" ? normalizeText(title).toLowerCase() : "";
}

/**
 * `sha256(normTitle + '\0' + first 500 chars of normalised text)`.
 *
 * The NUL separator matters: without it, a title of `ab` with text `c` and a
 * title of `a` with text `bc` produce identical input. NUL cannot occur in
 * either operand, because `sanitize` strips C0 controls from every body before
 * it is parsed (M2) — the two modules depend on each other here.
 *
 * Returns a Buffer, which is what `articles.content_hash BYTEA` stores. Hex is
 * for test output and logs, not for the column.
 */
export function contentHash(
  title: string | null | undefined,
  text: string | null | undefined,
): Buffer {
  const normTitle = normalizeTitle(title);
  const normText = (typeof text === "string" ? normalizeText(text) : "").slice(
    0,
    CONTENT_HASH_PREFIX_CHARS,
  );

  return createHash("sha256").update(`${normTitle}\0${normText}`, "utf8").digest();
}

/** The same value as lowercase hex, for logs, test names and debugging. */
export function contentHashHex(
  title: string | null | undefined,
  text: string | null | undefined,
): string {
  return contentHash(title, text).toString("hex");
}

/**
 * A fingerprint of rung 3's normalisation, for the version guard.
 *
 * Built from the data the rules use plus a hand-maintained list of the steps,
 * for the same reason as the URL ruleset's: code cannot fingerprint itself, so
 * adding a step means adding its name here — which is the moment to notice the
 * version needs bumping and that every stored digest has changed.
 */
export const CONTENT_HASH_FINGERPRINT = [
  `prefix:${CONTENT_HASH_PREFIX_CHARS}`,
  "nfc",
  "strip-script-style",
  "strip-comments",
  "strip-declarations",
  "strip-tag-like-only",
  "decode-entities",
  "strip-c0-after-decode",
  "collapse-whitespace",
  "trim",
  "lowercase-title",
  "nul-separator",
  "sha256",
  // key=VALUE pairs, not just keys. Fingerprinting only the names let a
  // changed MAPPING — `nbsp` to a non-breaking space, or correcting `prime` —
  // pass the guard, the pinned fingerprint and the entity-free golden digest,
  // while changing every digest the function produces.
  `entities:${Object.entries(NAMED_ENTITIES)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}`,
].join("|");
