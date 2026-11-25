import { describe, expect, it } from "vitest";

import { THIN_TEXT_CHARS, extractArticleHtml, needsExtraction } from "./readability";

/*
 * What this suite is for: the two ways extraction fails QUIETLY (§6.5).
 *
 *   AN EMPTY READING PANE. Readability returns a subtree it chose by heuristic,
 *   and on a page it misreads that subtree is a nav bar. There is no error — the
 *   reader opens an article and gets nothing, or gets the sidebar.
 *
 *   A PAGE THAT EXECUTES. Readability is a CONTENT EXTRACTOR, not a security
 *   boundary: picking the right `<div>` out of a hostile document does not
 *   remove the `onerror` inside it. Its output is third-party markup and has to
 *   go through the sanitiser like any other, which is the property asserted
 *   here rather than assumed from the call order in the source.
 *
 * NO NETWORK. Pages are literals, because the fetch belongs to the caller —
 * which is also what keeps the one sanctioned way out to the internet the only
 * thing that dials.
 */

const BASE = "https://harbourwire.example/2026/11/12/tidal-barrier-vote";

/** A page shaped like a real article: chrome around a body. */
function pageWith(body: string) {
  return `<!doctype html><html><head><title>Council votes to raise the barrier</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/news">News</a><a href="/sport">Sport</a></nav>
      <header><h1>Harbour Wire</h1></header>
      <article>${body}</article>
      <footer><p>© 2026 Harbour Wire. All rights reserved. Terms. Privacy.</p></footer>
    </body></html>`;
}

/** Enough prose to clear `THIN_TEXT_CHARS` several times over. */
const LONG = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. The harbour council voted last night to raise the tidal barrier at the mouth of the estuary by a metre, ending two years of argument over how high the town should build against the sea and what it ought to cost.</p>`,
).join("");

describe("pulling the article out of a page", () => {
  it("keeps the article and drops the chrome", () => {
    const result = extractArticleHtml(pageWith(LONG), { baseUrl: BASE });

    expect(result, "Readability found no article in a perfectly ordinary page").not.toBeNull();
    expect(result!.status).toBe("ok");
    expect(result!.contentHtml).toContain("Paragraph 1.");
    // The nav and footer are the test: an extraction that keeps them has not
    // extracted anything, and its text length passes a threshold on chrome.
    expect(result!.contentHtml).not.toContain("Privacy");
    expect(result!.contentHtml).not.toContain("Sport");
  });

  it("SANITISES what Readability returns", () => {
    /*
     * THE PROPERTY THAT MATTERS MOST HERE. Readability is handed a hostile
     * document and returns a subtree of it — so a payload INSIDE the article
     * element is exactly what it is designed to keep. Asserted on the output
     * rather than inferred from `sanitizeHtml` appearing in the source, because
     * the order of two calls is the kind of thing a refactor reverses.
     */
    const hostile = pageWith(
      `${LONG}<img src="x" onerror="alert(1)"><script>alert(2)</script>
       <iframe src="https://evil.example/"></iframe>
       <p>After <a href="javascript:alert(3)">the link</a>.</p>`,
    );

    const result = extractArticleHtml(hostile, { baseUrl: BASE });
    expect(result).not.toBeNull();

    const doc = new DOMParser().parseFromString(`<body>${result!.contentHtml}</body>`, "text/html");
    const tags = [...doc.body.querySelectorAll("*")].map((el) => el.tagName.toLowerCase());
    const attrs = [...doc.body.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((a) => a.name.toLowerCase()),
    );

    expect(tags).not.toContain("script");
    expect(tags).not.toContain("iframe");
    expect(attrs.filter((a) => a.startsWith("on"))).toEqual([]);
    expect(result!.contentHtml).not.toContain("javascript:");
    // And the article survived, so this is not passing by returning nothing.
    expect(result!.contentHtml).toContain("Paragraph 1.");
  });

  it("calls a page with almost nothing to read THIN, not ok", () => {
    /*
     * The gated-article shape: a real 200, real chrome, one paragraph of the
     * piece. It is not a failure and must not be reported as one — §6.5 gives
     * it its own copy, "the publisher likely gates the full text", because the
     * reader's next action is to open the original rather than to retry.
     */
    const result = extractArticleHtml(
      pageWith("<p>Subscribers can read the rest of this article.</p>"),
      { baseUrl: BASE },
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe("thin");
    expect(result!.textLength).toBeLessThan(THIN_TEXT_CHARS);
  });

  it("measures the text AFTER sanitising, not before", () => {
    /*
     * A page whose bulk is an embedded player and a form measures long to
     * Readability and short to a reader, because the allowlist removes both.
     * Taking Readability's own `textContent` would call this `ok` and hand the
     * pane two sentences with no explanation.
     */
    const padding = "Watch our video. ".repeat(60);
    const result = extractArticleHtml(
      pageWith(
        `<p>One real sentence of the article.</p>
         <iframe src="https://player.example/embed">${padding}</iframe>
         <form><label>Email<input name="email"></label>${padding}</form>`,
      ),
      { baseUrl: BASE },
    );

    expect(result).not.toBeNull();
    expect(result!.status, "padding inside dropped elements counted as article text").toBe("thin");
  });

  it("returns null rather than throwing on a page that is not one", () => {
    // These arrive from the open web. A 500 on a reader opening an article is
    // the wrong answer when `failed` already has copy written for it.
    for (const junk of ["", "   ", "<<<>>>", "not html at all", null, undefined, 42]) {
      expect(
        extractArticleHtml(junk as unknown as string, { baseUrl: BASE }),
        JSON.stringify(junk),
      ).toBeNull();
    }
  });

  it("passes images through the proxy rewrite", () => {
    const seen: string[] = [];
    const result = extractArticleHtml(pageWith(`${LONG}<p><img src="/photo.jpg"></p>`), {
      baseUrl: BASE,
      rewriteImage: (absolute) => {
        seen.push(absolute);
        return `/api/img?u=${encodeURIComponent(absolute)}`;
      },
    });

    expect(result).not.toBeNull();
    // ABSOLUTE by the time the proxy sees it: signing a relative address would
    // sign something that cannot be fetched.
    expect(seen).toContain("https://harbourwire.example/photo.jpg");
    expect(result!.contentHtml).toContain("/api/img?u=");
  });
});

describe("deciding whether a feed body needs extracting", () => {
  const prose = (n: number) => `<p>${"word ".repeat(n)}</p>`;

  it("extracts when there is no body at all", () => {
    expect(needsExtraction(null)).toBe(true);
    expect(needsExtraction(undefined)).toBe(true);
    expect(needsExtraction("")).toBe(true);
    expect(needsExtraction("   ")).toBe(true);
  });

  it("extracts a short body", () => {
    expect(needsExtraction("<p>Two sentences. That is all there is.</p>")).toBe(true);
  });

  it("LEAVES a full body alone, so a complete feed is never fetched", () => {
    /*
     * The expensive direction. §6.5's whole constraint is that extraction is
     * one page load per article a person asked for — a `needsExtraction` that
     * said true for everything would turn every open into an outbound request
     * against a publisher who already sent us the article.
     */
    expect(needsExtraction(prose(400))).toBe(false);
  });

  it("extracts a LONG body that ends in `continue reading`", () => {
    /*
     * The case a length test alone misses, and the common one: a feed that
     * sends three substantial paragraphs and then the marker. It is well over
     * the threshold and still not the article.
     */
    const teaser = `${prose(400)}<p>Continue reading at Harbour Wire.</p>`;
    expect(needsExtraction(teaser)).toBe(true);
    expect(needsExtraction(`${prose(400)}<p>Read more</p>`)).toBe(true);
    expect(needsExtraction(`${prose(400)}<p>Read the full story</p>`)).toBe(true);
  });

  it("extracts a long body that trails off in an ellipsis", () => {
    expect(needsExtraction(`${prose(400)}<p>and the council said that…</p>`)).toBe(true);
  });

  it("does NOT extract a body that merely mentions reading somewhere in the middle", () => {
    /*
     * Only the TAIL is inspected. A piece about a library, or one that happens
     * to use the word, is a complete body — matching anywhere would fetch the
     * publisher for an article they already sent in full.
     */
    const body = `<p>Read more books, the librarian said.</p>${prose(400)}`;
    expect(needsExtraction(body)).toBe(false);
  });
});
