import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

/*
 * Turning third-party markup into something safe to render (§6.5, N9).
 *
 * THIS IS THE ONE FAILURE IN THIS PROJECT THAT IS COMPLETELY SILENT. Every
 * other defect here announces itself: a wrong count is visible, a lost read is
 * noticed, a refused fetch is logged. A missed `<script>` renders perfectly,
 * looks like nothing happened, and turns the reader into an XSS delivery
 * service for its own session — the session that holds the Clerk cookie and can
 * reach every mutation in the app.
 *
 * WHY HTML AT ALL, rather than a typed block tree. `Article.body` used to be
 * `BodyBlock[]` — `{p} | {h} | {li[]}` — and §6.5's allowlist is far wider than
 * that: `img`, `a`, `blockquote`, `pre`, `code`, `table`, `figure`, `em`,
 * `strong`. A tree narrow enough to be obviously safe cannot carry an article,
 * and widening it to carry one means reimplementing HTML in types, badly. So
 * the safety boundary is the SANITISER rather than the shape, which is what
 * DOMPurify exists for and what its allowlist is for.
 *
 * SERVER-SIDE ONLY, and that is load-bearing. The client must never receive
 * markup it then cleans: by the time unsanitised HTML has crossed to the
 * browser it has already been in the document's reach, and a client that
 * forgets to call this once renders the raw thing. Sanitising at the data
 * boundary means the only HTML that ever leaves the server is clean.
 *
 * ALSO USED FOR ORDINARY FEED BODIES, not just extracted pages. `content_html`
 * comes from a feed, which is third-party markup by exactly the same argument
 * — it arrived over the network from someone we do not control. §6.5 frames
 * this as extraction's problem because extraction is where it was noticed, but
 * the feed path had the same exposure from M2 and simply never rendered it.
 */

/**
 * What an article body may contain (§6.5).
 *
 * An ALLOWLIST, never a denylist. A denylist is a bet that you have thought of
 * every dangerous element, against an attacker who only needs one you have not
 * — and the list of ways to execute script in HTML grows with every browser
 * release. This list grows only when a reader is missing something.
 */
const ALLOWED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "em",
  "strong",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "br",
];

/**
 * Attributes that survive. Everything else is dropped, including every `on*`.
 *
 * `on*` IS NOT LISTED AND MUST NOT BE. DOMPurify drops what is not allowed, so
 * an allowlist of attributes already excludes `onerror`, `onload` and the
 * couple of hundred others — naming them would imply the list is the defence,
 * and the next handler the HTML spec adds would then be the hole.
 */
const ALLOWED_ATTR = ["href", "src", "alt", "title", "colspan", "rowspan"];

/** A window to clean in. Node has no DOM, so one is built (§6.5). */
let windowForPurify: ReturnType<typeof makeWindow> | null = null;

function makeWindow() {
  /*
   * `about:blank` and NOTHING ELSE. jsdom with `runScripts` enabled would
   * execute the markup it is handed, which is the attack rather than the
   * defence — so scripts are never run, no resources are loaded, and the
   * document is inert. These are jsdom's defaults; they are stated because a
   * later convenience (`runScripts: "dangerously"` to make some library work)
   * would quietly undo the entire file.
   */
  return new JSDOM("", { url: "https://cadence.invalid/" }).window;
}

let purify: ReturnType<typeof createDOMPurify> | null = null;

function purifier() {
  if (purify !== null) return purify;

  // One window and one instance, reused: constructing a jsdom is tens of
  // milliseconds and this runs on every article open.
  windowForPurify ??= makeWindow();
  const made = createDOMPurify(windowForPurify as unknown as Window & typeof globalThis);

  /*
   * THROWS RATHER THAN FAILING OPEN. When DOMPurify decides the environment
   * has no usable DOM it sets `isSupported = false` and `sanitize()` then
   * RETURNS ITS INPUT UNCHANGED — markup straight through, no error, nothing
   * in a log. That is precisely the silent failure this file's header says
   * cannot be allowed to exist, arriving through the library rather than
   * through our own code. An article that fails to render is a visible bug; an
   * article that renders someone else's script is not.
   */
  if (!made.isSupported) {
    throw new Error("No DOM available to sanitise in; refusing to pass markup through.");
  }

  purify = made;
  return purify;
}

/**
 * Resolves one URL against the page it came from, or returns null.
 *
 * Null for anything that is not `http`/`https` — which is how `javascript:`,
 * `data:` and `vbscript:` hrefs are removed, by failing to be an address this
 * function will produce rather than by being matched and rejected. A denylist
 * of schemes has the same shape of hole as a denylist of tags.
 */
export function absoluteHttpUrl(value: string, base: string): string | null {
  /*
   * EMPTY IS NOT AN ADDRESS, and `new URL("", base)` does not say so — it
   * SUCCEEDS and returns the base. So `<img src="">` was rewritten to the
   * article's own page and handed to the proxy to sign and fetch as an image,
   * and `<a href="">` became a `target="_blank"` link back to the article the
   * reader was already on. Both are common in real feed HTML, where a
   * templating slip leaves the attribute present and blank.
   */
  if (typeof value !== "string" || value.trim() === "") return null;

  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

export type SanitizeOptions = {
  /**
   * The address the markup was SERVED FROM, which relative URLs resolve
   * against. For an extracted page that is where the fetch landed, not the
   * address stored on the article — a redirect moves what `href="../x"` means.
   */
  baseUrl: string;
  /**
   * Rewrites each image's resolved address to one the reader's browser will
   * fetch instead. Returns null to drop the image.
   *
   * INJECTED rather than imported, because the proxy needs a signing secret
   * and this file would otherwise require one to be configured before any feed
   * body could render at all. Omitted, images keep their own absolute address
   * — correct and less private, which is the state before the proxy lands.
   */
  rewriteImage?: (absolute: string) => string | null;
};

/** Third-party markup, cleaned and made absolute. Returns `""` for nothing usable. */
export function sanitizeHtml(html: string, options: SanitizeOptions): string {
  if (typeof html !== "string" || html.trim() === "") return "";

  const clean = purifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    /*
     * `<html><body>` wrappers removed, so the result can be inserted into an
     * existing document. Without this a whole document arrives nested, and the
     * reading pane renders a page inside a page.
     */
    WHOLE_DOCUMENT: false,
    /*
     * A DOM, not a string. `rewriteUrls` has to walk this anyway, and
     * serialising here only to reparse it there was both wasted work and a
     * second trip through an HTML parser on markup that had just been cleaned.
     */
    RETURN_DOM: true,
    /*
     * NO `FORBID_CONTENTS` — and this is the review finding worth remembering,
     * because the option REPLACES DOMPurify's default list rather than adding
     * to it. It was set to `["script", "style"]`, both of which are already in
     * the default 26, so the entire effect was DELETING the other 24:
     * `title`, `noscript`, `template`, `iframe`, `xmp`, `head`, the MathML
     * `annotation-xml` family and the SVG `foreignObject` family — every one of
     * them a place markup hides from a sanitiser that only inspects what
     * renders.
     *
     * Measured: `<p>a</p><title>Secret</title><p>b</p>` kept "Secret" as prose
     * with the option set, and dropped it without. A line written as defence in
     * depth was the only thing lowering the defence. `ADD_FORBID_CONTENTS` is
     * the additive form if this is ever genuinely needed.
     */
  });

  return rewriteUrls(clean, options);
}

/**
 * Makes every surviving `href` and `src` absolute, and drops what cannot be.
 *
 * SECOND PASS, after DOMPurify rather than inside it. A hook on DOMPurify would
 * run during sanitisation, where throwing or returning the wrong type leaves
 * the library mid-clean; this walks a document that is already safe, so the
 * worst a bug here can do is produce a broken link.
 */
function rewriteUrls(root: Element, { baseUrl, rewriteImage }: SanitizeOptions): string {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const absolute = absoluteHttpUrl(anchor.getAttribute("href") ?? "", baseUrl);
    if (absolute === null) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("href", absolute);
    /*
     * A link in an article body leaves this app, so it opens in a new tab with
     * the opener severed. `noopener` is the security half — without it the
     * opened page can reach back through `window.opener` and navigate the
     * reader somewhere else — and `noreferrer` keeps the reader's current
     * location from being announced, which is the same privacy the image proxy
     * exists for.
     */
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer nofollow");
  }

  for (const image of root.querySelectorAll("img")) {
    const absolute = absoluteHttpUrl(image.getAttribute("src") ?? "", baseUrl);
    if (absolute === null) {
      // No usable address. The element is removed rather than left as a broken
      // icon in the middle of a paragraph.
      image.remove();
      continue;
    }

    const src = rewriteImage === undefined ? absolute : rewriteImage(absolute);
    if (src === null) {
      image.remove();
      continue;
    }
    image.setAttribute("src", src);
    // Decoding off the main thread and out of the critical path. Harmless on an
    // image that is already visible, and these are below the fold by default.
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
  }

  return root.innerHTML;
}

/**
 * Plain text of some markup, for a length measurement.
 *
 * §6.5's `thin` test is on TEXT, not on bytes: a page that returns a kilobyte
 * of wrapper markup around two sentences has plenty of HTML and nothing to
 * read, and a byte count would call it a success.
 */
export function textOf(html: string): string {
  if (typeof html !== "string" || html === "") return "";

  // The CACHED window, not a new one. This is called per extraction to decide
  // `thin`, and standing up a jsdom costs tens of milliseconds.
  windowForPurify ??= makeWindow();
  const holder = windowForPurify.document.createElement("div");
  /*
   * `textContent` after a parse, and the parse has to happen somewhere. This
   * element is never inserted into a document, so nothing here loads a
   * resource or runs — and `textOf` is called on markup that has ALREADY been
   * through `sanitizeHtml` on every production path.
   */
  holder.innerHTML = html;
  return holder.textContent ?? "";
}
