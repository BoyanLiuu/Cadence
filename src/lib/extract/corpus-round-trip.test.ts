import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { articles } from "@/lib/fixtures";
import { contentHashHex } from "@/lib/ingest/content-hash";

import { sanitizeHtml, textOf } from "./sanitize";

/*
 * What this suite is for: the sanitiser eating the ARTICLE.
 *
 * `sanitize.test.ts` proves the hostile half — that a payload does not survive.
 * The opposite failure is just as real and much quieter: an allowlist that is
 * too narrow, a URL rewrite that drops a link, or a parser that reorders
 * markup, all of which make every article slightly wrong in a way no security
 * test notices and no error reports.
 *
 * So this runs THE WHOLE SEEDED CORPUS through the real sanitiser and asserts
 * it comes back unchanged. The corpus is the same HTML `prisma/seed.ts` writes
 * to `content_html`, and `db/map.ts` sanitises that column on every read — so
 * "unchanged" is the property that makes the fixtures path and the database
 * path render identically, which is Appendix C's parity rule applied to a
 * column that was previously exempt from it.
 *
 * NOT A PARITY TEST ITSELF, and deliberately not: `service-parity.test.ts`
 * compares the two implementations against a live database, and excluded
 * `body` on the grounds that fixtures were "richer than ingestion can yet
 * produce". That stopped being true when fixture bodies became HTML and the
 * seed began storing them verbatim. This asserts the half that needs no
 * database, so it runs in `pnpm check` on a clone with no Supabase project.
 */

/** Every fixture body that has markup in it. */
const bodies = articles
  .map((article) => ({ id: article.id, html: article.body }))
  .filter((entry) => entry.html !== "");

describe("the seeded corpus through the real sanitiser", () => {
  it("has bodies to check, so this suite cannot pass vacuously", () => {
    /*
     * The assertion below iterates an array. An empty one passes every case in
     * it and proves nothing — which is precisely how four tests in this project
     * have already passed while testing nothing, so the count is asserted
     * before the content.
     */
    expect(bodies.length).toBeGreaterThan(30);
  });

  it.each(bodies)("leaves article $id's body EXACTLY as written", ({ html }) => {
    /*
     * Byte-for-byte. A normalised-but-equivalent result would be defensible in
     * isolation and would mean the database path renders different markup from
     * the fixtures path for the same article — so the strict comparison is the
     * point, and a future allowlist change that reformats will fail here and
     * have to be decided rather than absorbed.
     */
    const out = sanitizeHtml(html, { baseUrl: "https://harbourwire.example/a/b" });
    expect(out).toBe(html);
  });

  it("agrees with the poller's digest on every article, INCIDENTALLY", () => {
    /*
     * These agree now, and the agreement is not the thing being protected.
     *
     * When the seed passed `textOf(body)` they disagreed on 15 of 124 — every
     * multi-paragraph article — because `textOf` concatenated across block
     * boundaries where `contentHash`'s own stripper leaves a word break. Fixing
     * `textOf` to insert that space happens to have made the two inputs
     * interchangeable TODAY.
     *
     * Which is exactly why the next test reads the seed's source instead of
     * trusting this. Two independent normalisers that currently agree are one
     * edit away from not, and nothing about that edit would look like it
     * touched the dedup ladder. This case records the state; the source guard
     * records the rule.
     *
     * (An earlier version of this test compared `contentHashHex(title, html)`
     * with `contentHashHex(title, article.body)` — the same value twice. It
     * passed against the bug it was written for, and is the fifth vacuous test
     * this project has caught.)
     */
    for (const { id, html } of bodies) {
      const article = articles.find((a) => a.id === id)!;
      expect(contentHashHex(article.title, textOf(html)), `article ${id}`).toBe(
        contentHashHex(article.title, html),
      );
    }
  });

  it("is seeded from the markup, not from text stripped first", async () => {
    /*
     * A SOURCE-LEVEL GUARD, because the property belongs to `prisma/seed.ts`
     * and there is no way to observe its choice from a value it computed.
     *
     * The bug is invisible until the next poll: the seed writes both
     * `content_html` and `content_hash`, ingestion recomputes that hash from
     * the raw body (`dedupe.ts` passes `item.contentHtml` straight through),
     * and if the seed normalised first the two disagree for the same unchanged
     * article. Nothing fails — instead the first poll calls it a revision, sets
     * `revised_at`, bumps `revision_count`, and on a feed with resurface on
     * returns a READ article to unread. §6.2 says an edit must not re-notify;
     * this manufactures edits that never happened. Rung 3 also stops matching
     * those rows, so a GUID-and-URL change that should collapse inserts a
     * duplicate instead. It affected 15 of 124 articles.
     *
     * Reading the source is the same tactic as `one-fetch-path.test.ts`, and
     * carries the same caveat recorded there: a guard that reads source has to
     * read what the compiler reads. This looks for one call, so a reformat
     * that splits it across lines fails the test rather than passing wrongly —
     * which is the safe direction for it to be wrong in.
     */
    // From `process.cwd()`, which vitest sets to the repo root. A URL relative
    // to `import.meta.url` resolved differently under the jsdom environment.
    const seed = await readFile(resolve(process.cwd(), "prisma/seed.ts"), "utf8");
    const call = /contentHash\(\s*article\.title\s*,\s*article\.body\s*\)/.test(seed);

    expect(call, "prisma/seed.ts must hash article.body, the same input ingestion hashes").toBe(
      true,
    );
  });

  it("measures the corpus as text, with nothing empty", () => {
    // `textOf` feeds `articles.text_len`, which feeds the reading-time estimate
    // on every row. A body that measures zero would print "0 min read".
    for (const { id, html } of bodies) {
      expect(textOf(html).trim().length, `article ${id}`).toBeGreaterThan(0);
    }
  });

  it("uses only elements the allowlist permits, so the corpus is not a special case", () => {
    /*
     * The round-trip above would also pass for a corpus made entirely of `<p>`,
     * which would make it a much weaker claim than it looks. This checks the
     * corpus actually exercises the allowlist's shape — and names what is NOT
     * yet represented rather than leaving that unknown.
     */
    const tags = new Set<string>();
    for (const { html } of bodies) {
      for (const match of html.matchAll(/<([a-z0-9]+)[\s>]/gi)) {
        tags.add(match[1]!.toLowerCase());
      }
    }

    /*
     * KNOWN GAP, recorded rather than asserted away: the corpus has paragraphs,
     * headings and lists — the three the old `BodyBlock` tree could express —
     * and no `img`, `a`, `blockquote`, `pre`, `figure` or `table`. So the
     * round-trip above says nothing about those, and they are covered case by
     * case in `sanitize.test.ts` instead.
     *
     * Asserted as an EXACT SET so the gap is visible on every run rather than
     * discovered later. It will fail when extraction starts writing real pages
     * into the corpus, and the right response then is to widen this list,
     * having looked at what arrived.
     */
    expect([...tags].sort()).toEqual(["h3", "li", "p", "ul"]);
  });
});
