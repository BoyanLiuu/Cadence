import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse } from "./parse";
import { charsetFromContentType, decode } from "./sniff";

/*
 * What this suite is for: the mojibake nobody catches in review.
 *
 * Every failure here produces output that LOOKS like success. A UTF-16 body
 * read as UTF-8 parses into fields full of NUL bytes. A latin-1 body read as
 * UTF-8 corrupts every accented name but still renders. Nobody opens the one
 * feed where the author is called "Zoë", so it ships.
 */

const DIR = join(__dirname, "../../../test/fixtures/feeds");
const bytes = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

describe("a BOM outranks everything", () => {
  it("detects UTF-16LE rather than reading it as NUL-filled UTF-8", () => {
    const result = parse(bytes("09-utf16le-bom.xml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    // The tell-tale of a UTF-16 body read as UTF-8: NULs inside the text.
    expect(result.items[0].title).toBe("Council votes to raise the tidal barrier");
    expect(result.items[0].title).not.toContain("\u0000");
  });

  it("strips a UTF-8 BOM instead of failing on it", () => {
    // A BOM left in place sits before the `<?xml` declaration and makes a
    // strict parser reject the document outright.
    const result = parse(bytes("06-utf8-bom.xml"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.items).toHaveLength(1);
  });

  it("beats a conflicting declaration", () => {
    // A UTF-8 BOM in front of a declaration claiming windows-1252: the BOM is
    // a fact about the bytes, the declaration is a claim about them.
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0" encoding="windows-1252"?><rss><channel/></rss>', "utf8"),
    ]);
    expect(decode(new Uint8Array(body)).source).toBe("bom");
  });
});

describe("the XML declaration outranks the HTTP header", () => {
  it("honours a windows-1252 declaration even when the header says UTF-8", () => {
    // §6.3's documented bet: publishers misconfigure the server far more often
    // than the file. Here it costs us — the bytes really are UTF-8, so reading
    // them as 1252 mojibakes the accents. That is the specified behaviour, and
    // this test pins it so the trade is a decision rather than an accident.
    const decoded = decode(
      bytes("07-declared-1252-actually-utf8.xml"),
      "application/rss+xml; charset=utf-8",
    );
    expect(decoded.source).toBe("declaration");
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.text).toContain("cafÃ©");
  });

  it("decodes genuine windows-1252 bytes so the accents survive", () => {
    // The case the rule above exists for, and the common one in the wild.
    const result = parse(bytes("08-windows-1252.xml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].title).toBe("A café on the quay");
    expect(result.items[0].title).not.toContain("�");
  });

  it("falls back to the header when the declaration names an unknown encoding", () => {
    // A label this runtime cannot build a decoder for must not fail the poll.
    const body = new TextEncoder().encode(
      '<?xml version="1.0" encoding="x-nonsense-9000"?><rss version="2.0"><channel/></rss>',
    );
    const decoded = decode(body, "application/rss+xml; charset=utf-8");
    expect(decoded.source).toBe("header");
    expect(decoded.encoding).toBe("utf-8");
  });
});

describe("with nothing declared", () => {
  it("defaults to UTF-8 when the bytes are valid UTF-8", () => {
    const decoded = decode(new TextEncoder().encode("<rss><channel/></rss>"));
    expect(decoded.source).toBe("utf-8-default");
  });

  it("falls back to windows-1252 when the bytes are not valid UTF-8", () => {
    // 0xE9 alone is not a legal UTF-8 sequence. Read as UTF-8 it becomes a
    // replacement character and the name is corrupted beyond recovery; read as
    // 1252 it is "é", which is almost certainly what was meant.
    const body = new Uint8Array([0x3c, 0x61, 0x3e, 0xe9, 0x3c, 0x2f, 0x61, 0x3e]);
    const decoded = decode(body);
    expect(decoded.source).toBe("fallback-1252");
    expect(decoded.text).toBe("<a>é</a>");
  });
});

describe("control characters never reach the data", () => {
  it("strips C0 controls that the parser would otherwise accept", () => {
    // The bug this caught: fast-xml-parser ACCEPTS a 0x08 mid-title, so a
    // strip that only runs after a parse failure never runs at all. The byte
    // then lands in the article title and in rung 3's content_hash, where it
    // makes one article hash two different ways.
    const result = parse(bytes("20-c0-control-chars.xml"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const title = result.items[0].title!;
    expect(title).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    expect(title).toBe("A title with a  backspace and a  unit separator");
  });

  it("keeps tab, newline and carriage return, which are legal", () => {
    const decoded = decode(new TextEncoder().encode("<a>one\ttwo\nthree\r\n</a>"));
    expect(decoded.text).toContain("\t");
    expect(decoded.text).toContain("\n");
  });
});

describe("charsetFromContentType", () => {
  it.each([
    ["application/rss+xml; charset=utf-8", "utf-8"],
    ['text/xml; charset="ISO-8859-1"', "iso-8859-1"],
    ["application/rss+xml", null],
    [undefined, null],
  ])("reads %s as %s", (header, expected) => {
    expect(charsetFromContentType(header)).toBe(expected);
  });
});
