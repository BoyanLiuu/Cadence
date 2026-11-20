/*
 * The hazard corpus, and what each body is SUPPOSED to do.
 *
 * Written before `sniff`, `preclean`, `parse` and `normalize` existed. That
 * order is the point: the plan's instruction is to capture the corpus first,
 * because fixtures written afterwards only agree with whatever you happened to
 * build. If a module disagrees with a row here, the module is wrong until
 * somebody argues otherwise in a commit message.
 *
 * Every file is a *.xml / *.json / *.html / *.txt beside this one. None is
 * fetched at test time, so the suite is offline, deterministic and polite.
 */

/** What the pipeline is expected to do with a body. */
export type Expectation =
  /** Parses to items. `items` is the RAW count, before normalisation drops any. */
  | { outcome: "ok"; dialect: "rss2" | "rss1" | "atom" | "json"; items: number }
  /** Recognised as a web page rather than a feed, and reported, never thrown. */
  | { outcome: "not_a_feed" }
  /** Recognisable but unusable. A typed rejection, never an exception. */
  | { outcome: "reject"; reason: "parse" | "empty" | "unsupported" };

export type Fixture = {
  file: string;
  /** The single hazard this body exists to represent. */
  hazard: string;
  /** The HTTP `Content-Type` the server sent — deliberately wrong in places. */
  contentType: string;
  /** The address it was fetched from, which is the last link in the base chain. */
  feedUrl: string;
  expect: Expectation;
  /** Set where the hazard is only visible after a pre-clean-and-retry. */
  needsRepair?: true;
};

export const corpus: Fixture[] = [
  {
    file: "01-rss2-cdata.xml",
    hazard: "RSS 2.0 with CDATA in description and content:encoded",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "02-atom-xml-base.xml",
    hazard: "Atom whose entry links are relative to xml:base",
    contentType: "application/atom+xml",
    feedUrl: "https://fenwickreview.example/feed.atom",
    expect: { outcome: "ok", dialect: "atom", items: 1 },
  },
  {
    file: "03-rdf-rss1.xml",
    hazard: "RSS 1.0 / RDF, whose root element is rdf:RDF",
    contentType: "application/rdf+xml",
    feedUrl: "https://orchardstreet.example/index.rdf",
    expect: { outcome: "ok", dialect: "rss1", items: 1 },
  },
  {
    file: "04-json-feed.json",
    hazard: "JSON Feed 1.1",
    contentType: "application/feed+json",
    feedUrl: "https://plainfield.example/changelog/feed.json",
    expect: { outcome: "ok", dialect: "json", items: 1 },
  },
  {
    file: "05-bare-ampersand.xml",
    hazard: "An unescaped bare & in a title and in a query string",
    contentType: "application/rss+xml",
    feedUrl: "https://ledgerandlathe.example/feed.xml",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
    // NO `needsRepair`, and that was a surprise worth recording. A conforming
    // XML parser rejects this document; fast-xml-parser accepts it AND yields
    // the correct value ("Ledger & Lathe", `?a=1&b=2`). The repair pass is
    // therefore dead code for this body today — the fixture stays because the
    // day the parser is swapped for a strict one, this is the body that catches
    // it, and `escapeBareAmpersands` is what will make it pass again.
  },
  {
    file: "06-utf8-bom.xml",
    hazard: "A UTF-8 BOM before the XML declaration",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "07-declared-1252-actually-utf8.xml",
    hazard: "Declares windows-1252 while serving UTF-8 bytes",
    // The header says UTF-8 and the declaration says otherwise. §6.3: the
    // declaration wins, because publishers misconfigure the server far more
    // often than the file.
    contentType: "application/rss+xml; charset=utf-8",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "08-windows-1252.xml",
    hazard: "Genuine windows-1252 bytes, correctly declared",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "09-utf16le-bom.xml",
    hazard: "UTF-16LE with a BOM, which read as UTF-8 is NUL-filled and still 'parses'",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "10-html-served-as-feed.html",
    hazard: "A web page where a feed was expected",
    // The lie that matters: the server claims a feed type.
    contentType: "application/rss+xml",
    feedUrl: "https://brightwater-gazette.example/feed",
    expect: { outcome: "not_a_feed" },
  },
  {
    file: "11-html-404-with-200.html",
    hazard: "An HTML 404 page served with 200 OK — the most common reported failure",
    contentType: "application/rss+xml",
    feedUrl: "https://hollowpinenotes.example/feed.xml",
    expect: { outcome: "not_a_feed" },
  },
  {
    file: "12-no-guid-anywhere.xml",
    hazard: "No <guid> on any item, as Hacker News publishes none",
    contentType: "application/rss+xml",
    feedUrl: "https://news.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 2 },
  },
  {
    file: "13-relative-links-only.xml",
    hazard: "Relative item links with no xml:base, so the feed URL is the base",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "14-five-hundred-items.xml",
    hazard: "500 items in one poll, which is the insert cap's input",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 500 },
  },
  {
    file: "15-zero-items.xml",
    hazard: "A valid feed with no items, which must not be an error",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 0 },
  },
  {
    file: "16-pubdate-is-build-time.xml",
    hazard: "pubDate equals the build time on every item, so everything looks new",
    contentType: "application/rss+xml",
    feedUrl: "https://static.example/feed.xml",
    expect: { outcome: "ok", dialect: "rss2", items: 4 },
  },
  {
    file: "17-declares-ttl.xml",
    hazard: "Declares <ttl>60</ttl>, which is a floor and never a ceiling",
    contentType: "application/rss+xml",
    feedUrl: "https://orchardstreet.example/feed",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "18-podcast-enclosures.xml",
    hazard: "A podcast feed with enclosures and the iTunes namespace",
    contentType: "application/rss+xml",
    feedUrl: "https://lowlandcourier.example/podcast/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "19-unclosed-tags.xml",
    hazard: "Three unclosed tags, which fail the whole poll without a pre-clean",
    contentType: "application/rss+xml",
    feedUrl: "https://saltmarshalmanac.example/feed",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
    needsRepair: true,
  },
  {
    file: "20-c0-control-chars.xml",
    hazard: "C0 control characters mid-document, which are illegal in XML 1.0",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
    // NO `needsRepair`, because the strip is unconditional rather than a
    // repair. This body is why: fast-xml-parser accepts a 0x08 mid-title and
    // carries it into the data, so waiting for a parse failure means the
    // control byte reaches the article title and rung 3's content hash.
    // `charset.spec.ts` asserts the characters are gone, not that a repair ran.
  },
  {
    file: "21-item-with-no-identity.xml",
    hazard: "An item with no guid, no link and no title beside a sound one",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    // Two raw items parse. Normalisation drops one, which `normalize.spec.ts`
    // asserts separately — synthesising an id from an array position is the one
    // choice that guarantees duplicates (§6.3).
    expect: { outcome: "ok", dialect: "rss2", items: 2 },
  },
  {
    file: "22-teaser-vs-content-encoded.xml",
    hazard: "A truncated description beside a full content:encoded",
    contentType: "application/rss+xml",
    feedUrl: "https://marginaliaweekly.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "23-atom-published-vs-updated.xml",
    hazard: "Atom where published and updated differ by six days",
    contentType: "application/atom+xml",
    feedUrl: "https://fenwickreview.example/feed.atom",
    expect: { outcome: "ok", dialect: "atom", items: 1 },
  },
  {
    file: "24-guid-permalink-vs-link.xml",
    hazard: "An alternate link and a permalink guid that disagree",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "25-dc-date-only.xml",
    hazard: "dc:date is the only date on the item",
    contentType: "application/rss+xml",
    feedUrl: "https://orchardstreet.example/index.rdf",
    expect: { outcome: "ok", dialect: "rss2", items: 1 },
  },
  {
    file: "26-plain-text-body.txt",
    hazard: "A plain-text apology served with 200",
    contentType: "text/plain",
    feedUrl: "https://slowhost.example/feed",
    expect: { outcome: "reject", reason: "unsupported" },
  },
  {
    file: "27-truncated-midway.xml",
    hazard: "Truncated mid-document, as a dropped connection leaves it",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "reject", reason: "parse" },
  },
  {
    file: "28-empty-body.xml",
    hazard: "An empty body with a 200",
    contentType: "application/rss+xml",
    feedUrl: "https://harbourwire.example/rss",
    expect: { outcome: "reject", reason: "empty" },
  },
  {
    file: "29-json-not-a-feed.json",
    hazard: "Valid JSON that is not a feed",
    contentType: "application/json",
    feedUrl: "https://api.example/status.json",
    expect: { outcome: "reject", reason: "unsupported" },
  },
  {
    // Added after M2's review, which is why the corpus is 31 rather than the
    // plan's 30. `xml:base` nests, so an entry can narrow the feed's base —
    // and a wrong URL here is a wrong `url_hash`, which is rung 2's dedupe
    // key, so the cost is a duplicate reaching the reader rather than merely a
    // broken link.
    file: "31-entry-level-xml-base.xml",
    hazard: "Entry-level xml:base, relative and absolute, narrowing the feed's",
    contentType: "application/atom+xml",
    feedUrl: "https://fenwickreview.example/feed.atom",
    expect: { outcome: "ok", dialect: "atom", items: 3 },
  },
  {
    file: "30-xml-but-not-a-feed.xml",
    hazard: "Well-formed XML that is neither RSS, Atom nor RDF — a sitemap",
    contentType: "application/xml",
    feedUrl: "https://harbourwire.example/sitemap.xml",
    expect: { outcome: "reject", reason: "unsupported" },
  },
];
