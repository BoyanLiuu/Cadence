import type { Dialect } from "@/lib/types";

/*
 * What is this body, and how is it encoded?
 *
 * ARCHITECTURE §6.3 is the specification. Two rules drive everything here, and
 * both exist because the obvious alternative fails silently:
 *
 *  1. THE ROOT ELEMENT DECIDES THE FORMAT, never `Content-Type`. A publisher
 *     serving an HTML error page with `Content-Type: application/rss+xml` is
 *     the single most common user-reported failure. Trusting the header parses
 *     a web page as a feed, finds no items, and reads as "the feed went quiet"
 *     rather than as the breakage it is.
 *  2. CHARSET PRECEDENCE IS BOM, THEN THE XML DECLARATION, THEN THE HTTP
 *     HEADER, THEN UTF-8 — because publishers misconfigure the server far more
 *     often than they misdeclare the file.
 */

/** Enough bytes to see a BOM, an XML declaration and the first element. */
export const SNIFF_WINDOW = 1024;

/** How much to validate before concluding a body is not UTF-8 (§6.3). */
const UTF8_VALIDATION_WINDOW = 64 * 1024;

type Bom = { encoding: "utf-8" | "utf-16le" | "utf-16be"; length: number };

/**
 * Decodes, or returns null if this runtime has no decoder for the label.
 *
 * Every call site is guarded, because an encoding label is attacker-controlled
 * in practice — it comes out of a remote document — and `new TextDecoder()`
 * throws on one it does not know.
 */
function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

/** A BOM is the only encoding signal that outranks the document's own claim. */
function readBom(bytes: Uint8Array): Bom | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", length: 2 };
  }
  return null;
}

/**
 * True when the bytes are valid UTF-8.
 *
 * Used only to catch a body that declares nothing and is not UTF-8 either.
 * `TextDecoder` with `fatal` does the work; hand-rolling the state machine is
 * how you get a validator that accepts overlong encodings.
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, UTF8_VALIDATION_WINDOW));
    return true;
  } catch {
    return false;
  }
}

/**
 * The encoding an XML declaration claims, if there is one.
 *
 * Read from a Latin-1 view of the first bytes rather than from a decoded
 * string, because decoding is the thing being decided. Every encoding worth
 * supporting agrees with ASCII on `<?xml ... ?>`, with the exception of UTF-16
 * — which a BOM has already settled by the time this runs.
 */
function declaredEncoding(bytes: Uint8Array): string | null {
  const head = new TextDecoder("iso-8859-1").decode(bytes.subarray(0, SNIFF_WINDOW));
  const decl = /<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return decl ? decl[1].trim().toLowerCase() : null;
}

/** The charset from an HTTP `Content-Type`, if it carried one. */
export function charsetFromContentType(contentType?: string): string | null {
  if (!contentType) return null;
  const m = /charset\s*=\s*"?([^;"\s]+)"?/i.exec(contentType);
  return m ? m[1].trim().toLowerCase() : null;
}

export type Decoded = {
  text: string;
  /** Which encoding was actually used, and why — both go in the fetch log. */
  encoding: string;
  source: "bom" | "declaration" | "header" | "utf-8-default" | "fallback-1252";
};

/**
 * Decodes a body to text under §6.3's precedence.
 *
 * The one case worth stating plainly: a body whose declaration says
 * `windows-1252` while the bytes are really UTF-8 is decoded as windows-1252,
 * which mojibakes the accents. That is the documented rule and it is the right
 * bet — a wrong declaration is rarer than a wrong server header, and the
 * inverse case (server says UTF-8, file says latin-1) is the common one. If a
 * real feed ever proves otherwise, change it here and record the feed.
 */
export function decode(bytes: Uint8Array, contentType?: string): Decoded {
  const bom = readBom(bytes);
  if (bom) {
    const body = bytes.subarray(bom.length);
    const text = tryDecode(body, bom.encoding);
    // Guarded like every other branch: `parse` promises never to throw, and a
    // runtime without the UTF-16 decoders (Edge) would otherwise throw from
    // here and take the whole sweep down.
    if (text !== null) return { text, encoding: bom.encoding, source: "bom" };
  }

  const declared = declaredEncoding(bytes);
  if (declared) {
    const text = tryDecode(bytes, declared);
    // An unknown label falls through rather than failing the poll.
    if (text !== null) return { text, encoding: declared, source: "declaration" };
  }

  const header = charsetFromContentType(contentType);
  if (header) {
    const text = tryDecode(bytes, header);
    if (text !== null) return { text, encoding: header, source: "header" };
  }

  if (isValidUtf8(bytes)) {
    return {
      text: new TextDecoder("utf-8").decode(bytes),
      encoding: "utf-8",
      source: "utf-8-default",
    };
  }

  // Declares nothing and is not UTF-8. windows-1252 is the overwhelmingly
  // likely legacy answer and, unlike UTF-8, it cannot fail on any byte — so
  // the accented names come out right instead of as replacement characters.
  const legacy = tryDecode(bytes, "windows-1252");
  if (legacy !== null) {
    return { text: legacy, encoding: "windows-1252", source: "fallback-1252" };
  }

  // Nothing worked. UTF-8 with replacement characters is lossy but always
  // available, and a body we can read imperfectly beats failing the poll.
  return {
    text: new TextDecoder("utf-8").decode(bytes),
    encoding: "utf-8",
    source: "utf-8-default",
  };
}

/**
 * The format, from the bytes.
 *
 * `Content-Type` is deliberately not a parameter. A caller cannot pass it in
 * and so cannot be tempted to trust it.
 */
export function sniff(head: Uint8Array): Dialect {
  const { text } = decode(head);
  return sniffText(text);
}

/** The same decision, on already-decoded text. */
export function sniffText(text: string): Dialect {
  // Strip a BOM the decoder may have left, plus leading whitespace, the XML
  // declaration, comments, doctypes and processing instructions — a publisher
  // may put any of them before the root element.
  let s = text.replace(/^﻿/, "").trimStart();

  if (s.length === 0) return "unknown";

  // JSON Feed: a leading `{` and an `items` array. Checked before the XML
  // stripping below, because a JSON body has no root element to find.
  if (s.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(s);
      return typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { items?: unknown }).items)
        ? "json"
        : "unknown";
    } catch {
      // Not parseable as a whole. That does NOT mean it is not a JSON Feed:
      // this function is also handed a truncated head, and a full `JSON.parse`
      // of the first kilobyte of a 50 KB feed always throws. Fall back to
      // looking for the `items` array structurally, which is the one key the
      // format requires and which an API response like `{"data":[…]}` lacks.
      return /"items"\s*:\s*\[/.test(s) ? "json" : "unknown";
    }
  }

  for (;;) {
    const before = s;
    s = s
      .replace(/^<\?xml[\s\S]*?\?>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<\?[\s\S]*?\?>/, "")
      .trimStart();
    // A doctype is how an HTML page announces itself, so look before stripping.
    if (/^<!doctype\s+html/i.test(s)) return "not_a_feed";
    s = s.replace(/^<!DOCTYPE[^>]*>/i, "").trimStart();
    if (s === before) break;
  }

  if (/^<!doctype\s+html/i.test(s)) return "not_a_feed";
  if (/^<html[\s>]/i.test(s)) return "not_a_feed";

  // The root element decides. Namespace prefixes are arbitrary, so match on
  // the local name: `<rdf:RDF>`, `<RDF>` and `<x:RDF>` are the same document.
  const root = /^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s/>]/.exec(s);
  if (!root) return "unknown";

  switch (root[2].toLowerCase()) {
    case "rss":
      return "rss2";
    case "rdf":
      return "rss1";
    case "feed":
      return "atom";
    default:
      // Well-formed XML that is not a feed: a sitemap, an API response, an
      // XML error document. Reported as unknown rather than as not_a_feed,
      // because `not_a_feed` carries the specific "this is a web page" copy.
      return "unknown";
  }
}
