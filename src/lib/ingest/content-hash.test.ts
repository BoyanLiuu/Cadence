import { describe, expect, it } from "vitest";

import {
  CONTENT_HASH_PREFIX_CHARS,
  contentHash,
  contentHashHex,
  normalizeTitle,
} from "./content-hash";

/*
 * What this suite is for: a hash that moves when the text did not.
 *
 * Rung 3 exists to catch an article whose guid AND url both changed in one
 * build. It only works if the hash is stable against everything that is not
 * content — and unstable against everything that is.
 *
 *   - A hash that moves on a re-indented template re-publishes an entire
 *     archive as new, and every article the reader finished comes back unread.
 *   - A hash that does NOT move when the text really changed merges two
 *     different articles, which §6.1 says is the worse failure, and is why
 *     this is equality and never similarity.
 */

const same = (a: Buffer, b: Buffer) => a.equals(b);

describe("stable against things that are not content", () => {
  it("ignores whitespace runs and indentation", () => {
    // The commonest false positive: a publisher reformats their template.
    expect(
      same(
        contentHash("Council votes", "The  council\n   voted\tlast night"),
        contentHash("Council votes", "The council voted last night"),
      ),
    ).toBe(true);
  });

  it("ignores leading and trailing whitespace", () => {
    expect(same(contentHash("  Title  ", "  text  "), contentHash("Title", "text"))).toBe(true);
  });

  it("ignores entity spelling", () => {
    // `&amp;` and `&` are the same character. A feed switching its encoder
    // must not re-publish.
    expect(
      same(contentHash("Ledger &amp; Lathe", "a &lt; b"), contentHash("Ledger & Lathe", "a < b")),
    ).toBe(true);
    expect(same(contentHash("A&#8230;", ""), contentHash("A…", ""))).toBe(true);
    expect(same(contentHash("A&#x2026;", ""), contentHash("A…", ""))).toBe(true);
    expect(same(contentHash("caf&eacute;", ""), contentHash("café", ""))).toBe(true);
  });

  it("ignores markup and attribute order", () => {
    // Attributes vanish with their tags, which is what makes reordering a
    // no-op rather than something separately handled.
    expect(
      same(
        contentHash("T", '<a href="x" class="y">one</a> two'),
        contentHash("T", '<a class="y" href="x">one</a> two'),
      ),
    ).toBe(true);
  });

  it("ignores a tag added around unchanged text", () => {
    expect(same(contentHash("T", "<p>one two</p>"), contentHash("T", "one two"))).toBe(true);
  });

  it("ignores Unicode composition", () => {
    // `é` as one code point and as `e` + combining acute look identical and
    // read identically. A CMS migration that changes composition would
    // otherwise re-publish every accented title.
    expect(same(contentHash("café", ""), contentHash("café", ""))).toBe(true);
  });

  it("ignores title case", () => {
    // A headline restyled from title case to sentence case is not a new
    // article. Safe because the first 500 characters of text must match too.
    expect(
      same(contentHash("Council Votes To Raise", "x"), contentHash("council votes to raise", "x")),
    ).toBe(true);
  });

  it("ignores script and style content entirely", () => {
    expect(
      same(contentHash("T", "<script>var a = 1;</script>one two"), contentHash("T", "one two")),
    ).toBe(true);
  });

  it("ignores an HTML comment", () => {
    expect(same(contentHash("T", "<!-- build 4821 -->one two"), contentHash("T", "one two"))).toBe(
      true,
    );
  });

  it("ignores text beyond the first 500 characters", () => {
    // Only the prefix is hashed, so a publisher appending a footer, a related-
    // links block or a comment count does not re-publish the article.
    const prefix = "a".repeat(CONTENT_HASH_PREFIX_CHARS);
    expect(same(contentHash("T", prefix), contentHash("T", `${prefix} and much more`))).toBe(true);
  });
});

describe("unstable when the content really changed", () => {
  it("moves when the title changes", () => {
    expect(same(contentHash("One", "x"), contentHash("Two", "x"))).toBe(false);
  });

  it("moves when the text changes within the first 500 characters", () => {
    expect(
      same(contentHash("T", "nine votes to four"), contentHash("T", "nine votes to five")),
    ).toBe(false);
  });

  it("moves on a one-character change at the very edge of the window", () => {
    // Off-by-one at the boundary would make the last character of the window
    // invisible, which is a small blind spot that is impossible to debug.
    const a = `${"x".repeat(CONTENT_HASH_PREFIX_CHARS - 1)}a`;
    const b = `${"x".repeat(CONTENT_HASH_PREFIX_CHARS - 1)}b`;
    expect(same(contentHash("T", a), contentHash("T", b))).toBe(false);
  });

  it("separates a title/text split that would otherwise collide", () => {
    // The NUL separator earns its place here: without it, title `ab` + text
    // `c` and title `a` + text `bc` hash the same input.
    expect(same(contentHash("ab", "c"), contentHash("a", "bc"))).toBe(false);
  });

  it("does not treat stripped markup as a word boundary collapse", () => {
    // `<p>one</p><p>two</p>` must not become `onetwo` and collide with an
    // article whose text genuinely is `onetwo`.
    expect(same(contentHash("T", "<p>one</p><p>two</p>"), contentHash("T", "onetwo"))).toBe(false);
  });

  it("keeps text an author escaped, while stripping real markup", () => {
    // An author writing *about* markup writes `<script>` as `&lt;script&gt;`.
    // That is their prose and must survive. A real `<script>` tag is not prose
    // and must not. Stripping tags BEFORE decoding entities is what separates
    // them — decode first and the escaped text becomes a tag and is deleted.
    //
    // So these three are deliberately all different:
    expect(same(contentHash("T", "&lt;script&gt;"), contentHash("T", ""))).toBe(false);
    expect(contentHashHex("T", "&lt;script&gt;")).not.toBe(contentHashHex("T", "<script>"));
    // ...and a bare tag with no text in it contributes nothing, as it should.
    expect(contentHashHex("T", "<script>")).toBe(contentHashHex("T", ""));
  });
});

describe("edges", () => {
  it("handles null and undefined as empty", () => {
    expect(same(contentHash(null, null), contentHash("", ""))).toBe(true);
    expect(same(contentHash(undefined, undefined), contentHash("", ""))).toBe(true);
  });

  it("hashes an item with a title and no text", () => {
    // A title alone is identity enough for rung 3 (see normalize.ts), so this
    // must produce a usable, distinct hash rather than a constant.
    expect(same(contentHash("Only a title", null), contentHash("Another title", null))).toBe(false);
  });

  it("leaves a malformed entity as literal text rather than throwing", () => {
    expect(() => contentHash("T", "&notanentity; &#; &#x;")).not.toThrow();
    // An unrecognised entity keeps its own spelling, so it is still content.
    expect(contentHashHex("T", "&notanentity;")).toBe(contentHashHex("T", "&notanentity;"));
    expect(contentHashHex("T", "&notanentity;")).not.toBe(contentHashHex("T", ""));
    expect(contentHashHex("T", "&notanentity;")).not.toBe(contentHashHex("T", "&otherthing;"));
  });

  it("refuses a surrogate code point rather than producing lone surrogates", () => {
    // `&#xD800;` is not a character. Decoding it yields an unpaired surrogate,
    // which is not valid UTF-8 and hashes unpredictably across runtimes — so
    // the entity is left as literal text instead. Comparing the call with
    // itself would pass with the guard deleted, so compare against both the
    // decoded and the empty forms.
    expect(() => contentHash("T", "&#xD800;")).not.toThrow();
    expect(contentHashHex("T", "&#xD800;")).toBe(contentHashHex("T", "&#xD800;"));
    expect(contentHashHex("T", "&#xD800;")).not.toBe(contentHashHex("T", ""));
    expect(contentHashHex("T", "&#xD800;")).not.toBe(contentHashHex("T", "\ud800"));
  });

  it("does not let an entity forge the NUL separator", () => {
    // `&#0;` survives M2's `sanitize` — it is an entity, not a literal control
    // byte — and used to decode to a real NUL right here, which forged the
    // separator and collided these two.
    expect(same(contentHash("a&#0;b", "c"), contentHash("a", "b&#0;c"))).toBe(false);
    expect(contentHashHex("a&#0;b", "c")).toBe(contentHashHex("ab", "c"));
  });

  it("does not eat prose containing a bare less-than", () => {
    // The worst bug this module had: `/<[^>]*>/` ate everything between a `<`
    // and the next `>`, so these two different articles hashed identically.
    // Post-parse text is where it bites — XML decoding has already turned the
    // author's `&lt;` into a real `<` by the time the text arrives.
    expect(
      same(
        contentHash("T", "5 < 6 and the vote was 7 > 8"),
        contentHash("T", "5 < 6 and the vote was 9 > 8"),
      ),
    ).toBe(false);
  });

  it("keeps a bare less-than as content", () => {
    expect(contentHashHex("T", "a < b")).not.toBe(contentHashHex("T", "a  b"));
  });

  it("decodes named entities CASE-SENSITIVELY", () => {
    // `&Eacute;` is É and `&eacute;` is é — different characters, not two
    // spellings of one. Lower-casing the lookup made `CAF&Eacute;` hash as
    // `CAFé`, which is a different word.
    expect(contentHashHex("T", "CAF&Eacute;")).toBe(contentHashHex("T", "CAFÉ"));
    expect(contentHashHex("T", "CAF&Eacute;")).not.toBe(contentHashHex("T", "CAFé"));
    expect(contentHashHex("T", "caf&eacute;")).toBe(contentHashHex("T", "café"));
  });

  it("decodes a hex reference whichever case the x is", () => {
    expect(contentHashHex("T", "&#X41;")).toBe(contentHashHex("T", "A"));
    expect(contentHashHex("T", "&#x41;")).toBe(contentHashHex("T", "A"));
  });

  it("returns 32 bytes, which is what the BYTEA column stores", () => {
    expect(contentHash("T", "x")).toHaveLength(32);
    expect(contentHashHex("T", "x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("determinism", () => {
  it("gives the same digest every time", () => {
    // M7 reruns this on every poll; a difference between runs reads as an edit
    // and bumps revision_count on an article nobody touched.
    const once = contentHashHex("Council votes", "<p>The council voted last night.</p>");
    for (let i = 0; i < 50; i += 1) {
      expect(contentHashHex("Council votes", "<p>The council voted last night.</p>")).toBe(once);
    }
  });

  it("is pinned to a committed digest", () => {
    // A golden value. Any change to normalisation or to the hash construction
    // breaks this, which is the signal to think about whether every stored
    // content_hash has just been invalidated.
    expect(contentHashHex("Council votes", "The council voted last night.")).toBe(
      "5ac2debda65b3bb5b73f18a64fb5e59168dc23172e08cdcdffde85ee26197f53",
    );
  });
});

describe("normalizeTitle", () => {
  it.each([
    ["  Council   Votes  ", "council votes"],
    ["Ledger &amp; Lathe", "ledger & lathe"],
    ["<em>Emphatic</em> title", "emphatic title"],
    [null, ""],
    [undefined, ""],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeTitle(input as string | null | undefined)).toBe(expected);
  });
});
