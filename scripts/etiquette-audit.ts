import { writeFile } from "node:fs/promises";

import "dotenv/config";

import { fetchFeed, USER_AGENT, type Validators } from "../src/lib/ingest/fetch";

/*
 * The etiquette audit (§6.4, M14, N8).
 *
 * WHY THIS CANNOT BE A UNIT TEST, which is the whole reason it is a script.
 * Conditional GET is a negotiation with servers we do not control: we send
 * `If-None-Match` and `If-Modified-Since` and a polite server answers `304` with
 * no body. A mock answers however the mock was written, so a suite built on one
 * proves that our code handles a 304 — never that real servers give us one.
 *
 * And getting it wrong is SILENT. A malformed `If-Modified-Since`, an ETag
 * quoted when it should not be, a header we never send at all: every one of
 * those produces a perfectly working reader that re-downloads every feed in
 * full on every poll, forever. The reader looks identical. The publishers see
 * the difference.
 *
 * So: 20 real feeds, polled TWICE, and the ratio of 304s on the second pass is
 * the number. §6.4 asks for at least half. A low ratio means our headers are
 * wrong against real servers, not that the feeds are unusual.
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT TALKS TO OTHER PEOPLE'S SERVERS
 * ---------------------------------------------------------------------------
 * Which makes it the only thing in this repo that is visible outside it, and
 * the audit is about politeness, so the script has to be polite:
 *
 *   TWO REQUESTS PER FEED THAT WE INITIATE, which is the minimum that can
 *   measure a conditional GET at all: one to learn the validators, one to use
 *   them. A feed that REDIRECTS costs more hops than that — `fetchFeed`
 *   follows up to `MAX_REDIRECTS` (5) by hand, re-guarding each — so the true
 *   ceiling is twelve requests for a feed behind a redirect chain, not two.
 *   Worth stating accurately: an earlier version of this comment claimed
 *   "never more", which is the kind of politeness claim that should be exact.
 *
 *   SEQUENTIAL, with a pause between hosts. Forty requests fired at once from
 *   one address is the shape of an attack, whatever the intent.
 *
 *   THE REAL `User-Agent`, which names the project and a contact. A publisher
 *   seeing this in their logs can tell what it was and ask us to stop.
 *
 *   THROUGH `fetchFeed`, the one sanctioned exit, so the SSRF guard, the body
 *   cap and the timeouts all apply — and so what this measures is the code
 *   that runs in production rather than a second implementation.
 *
 * NOT RUN IN CI, and not part of `pnpm check`. It is a measurement taken
 * deliberately, with the result written to a file and quoted in the README.
 * A CI job hitting 20 publishers on every push is exactly the thing §6.4 is
 * trying to prevent.
 */

/** Pause between feeds, so the whole audit is a trickle rather than a burst. */
const PAUSE_MS = 2_000;

/**
 * The feeds. Real, varied by platform, and chosen for what they TEST.
 *
 * The mix is the point: a `304` from one CDN says nothing about a
 * self-hosted WordPress, and §6.4's claim is about the fleet. These span
 * Substack, WordPress, Ghost, static-site generators, two large publishers and
 * one feed with no ETag at all — because `Last-Modified` alone is the case
 * most likely to be mishandled.
 */
const FEEDS = [
  "https://news.ycombinator.com/rss",
  "https://simonwillison.net/atom/everything/",
  "https://www.theguardian.com/world/rss",
  "https://feeds.bbci.co.uk/news/rss.xml",
  "https://blog.rust-lang.org/feed.xml",
  "https://github.blog/feed/",
  "https://overreacted.io/rss.xml",
  "https://jvns.ca/atom.xml",
  "https://danluu.com/atom.xml",
  "https://blog.cloudflare.com/rss/",
  "https://www.joelonsoftware.com/feed/",
  "https://martinfowler.com/feed.atom",
  "https://react.dev/rss.xml",
  "https://nodejs.org/en/feed/blog.xml",
  "https://stackoverflow.blog/feed/",
  "https://vercel.com/atom",
  "https://developer.mozilla.org/en-US/blog/rss.xml",
  "https://www.phoronix.com/rss.php",
  "https://lwn.net/headlines/rss",
  "https://blog.codinghorror.com/rss/",
];

type Row = {
  url: string;
  first: {
    kind: string;
    status: number | null;
    etag: boolean;
    lastModified: boolean;
    bytes: number;
  };
  second: { kind: string; status: number | null; conditional: boolean; soft: boolean };
  /**
   * `304` is the SERVER saying not-modified. `soft-unchanged` is us
   * downloading the whole body again and noticing it matched.
   *
   * THESE MUST NOT BE COUNTED TOGETHER, and the first version of this script
   * did. `fetchFeed` reports both as `kind: "unchanged"` — correctly, because
   * to the poller the outcome IS the same — and this audit is about
   * BANDWIDTH, where they are opposites: a 304 is a round trip with no body,
   * a soft unchanged is the whole feed transferred for nothing. Merging them
   * turned 14 of 18 into 18 of 18 and printed "100 % PASS", which is the exact
   * flattery this measurement exists to prevent.
   */
  verdict: "304" | "soft-unchanged" | "200-again" | "failed-first" | "failed-second";
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function auditOne(url: string): Promise<Row> {
  const first = await fetchFeed(url);

  if (first.kind !== "changed") {
    return {
      url,
      first: { kind: first.kind, status: first.status, etag: false, lastModified: false, bytes: 0 },
      second: { kind: "-", status: null, conditional: false, soft: false },
      verdict: "failed-first",
    };
  }

  /*
   * THE VALIDATORS THE POLLER WOULD HAVE STORED, which is what makes this the
   * real measurement. A hand-built `If-None-Match` would test a header this
   * script invented; these are the values `storeValidators` writes and the
   * next tick sends back.
   */
  const validators: Validators = {
    etag: first.etag,
    lastModified: first.lastModified,
    bodyHash: first.bodyHash,
  };
  const conditional = first.etag !== null || first.lastModified !== null;

  await sleep(PAUSE_MS);
  const second = await fetchFeed(url, validators);

  return {
    url,
    first: {
      kind: first.kind,
      status: first.status,
      etag: first.etag !== null,
      lastModified: first.lastModified !== null,
      bytes: first.bytes,
    },
    second: {
      kind: second.kind,
      status: second.kind === "failed" ? second.status : (second.status ?? null),
      conditional,
      soft: second.kind === "unchanged" ? second.soft : false,
    },
    verdict:
      second.kind === "unchanged"
        ? second.soft
          ? "soft-unchanged"
          : "304"
        : second.kind === "changed"
          ? "200-again"
          : "failed-second",
  };
}

async function main() {
  console.log(`Etiquette audit — ${FEEDS.length} feeds, 2 requests each.`);
  console.log(`User-Agent: ${USER_AGENT}\n`);

  const rows: Row[] = [];
  for (const url of FEEDS) {
    try {
      const row = await auditOne(url);
      rows.push(row);
      const sent = row.second.conditional ? "conditional" : "NO VALIDATORS SENT";
      console.log(`${row.verdict.padEnd(13)} ${sent.padEnd(18)} ${url}`);
    } catch (error) {
      console.log(`threw         ${url}: ${String(error)}`);
    }
    await sleep(PAUSE_MS);
  }

  /*
   * BOTH REQUESTS HAD TO SUCCEED, or the feed is not evidence either way.
   *
   * This excluded only `failed-first`, so a publisher that answered the first
   * request and errored on the SECOND stayed in the denominator while being
   * unable to enter the numerator — counted as a failure to honour conditional
   * requests when what actually happened was an outage mid-audit. With 18
   * reachable feeds that is enough to move the ratio across §6.4's 50 % line
   * and flip the verdict.
   */
  const reached = rows.filter((r) => r.verdict !== "failed-first" && r.verdict !== "failed-second");
  const notModified = rows.filter((r) => r.verdict === "304");
  /*
   * COUNTED SEPARATELY, because it IS the failure this audit is for. A soft
   * unchanged means we asked without usable validators — or the server ignored
   * them — downloaded the entire feed, and compared hashes to discover nothing
   * had changed. The reader behaves correctly; the publisher paid for the
   * whole transfer.
   */
  const soft = rows.filter((r) => r.verdict === "soft-unchanged");
  /*
   * MEASURED OVER FEEDS WE ACTUALLY REACHED. Counting a host that was down as
   * a failure to honour conditional requests would blame our headers for
   * somebody else's outage — and the ratio is a claim about OUR headers.
   */
  const ratio = reached.length === 0 ? 0 : notModified.length / reached.length;

  /*
   * THE SECOND NUMBER, and the one that localises a fault. A feed that sent
   * neither an ETag nor a `Last-Modified` cannot answer 304 however correct we
   * are — so a low ratio alongside a high "no validators offered" count means
   * the FEEDS are unusual, while a low ratio with validators offered
   * everywhere means our request headers are wrong. Reporting only the ratio
   * cannot tell those apart, which is the difference between fixing our code
   * and shrugging.
   */
  const offeredNone = reached.filter((r) => !r.second.conditional);

  const wastedKiB = soft.reduce((sum, r) => sum + r.first.bytes, 0) / 1024;

  console.log(`\nReached:               ${reached.length} of ${FEEDS.length}`);
  console.log(`Real 304:              ${notModified.length} (${(ratio * 100).toFixed(0)} %)`);
  console.log(
    `Soft unchanged:        ${soft.length} — full body re-downloaded, ${wastedKiB.toFixed(0)} KiB wasted`,
  );
  console.log(`Offered no validator:  ${offeredNone.length}`);
  console.log(`§6.4 asks for:        at least 50 %`);
  console.log(ratio >= 0.5 ? "\nPASS" : "\nBELOW THE BAR — see the per-feed log above");

  const report = {
    at: new Date().toISOString(),
    userAgent: USER_AGENT,
    feeds: FEEDS.length,
    reached: reached.length,
    notModified: notModified.length,
    softUnchanged: soft.map((r) => ({ url: r.url, bytes: r.first.bytes })),
    ratio: Number(ratio.toFixed(3)),
    offeredNoValidator: offeredNone.map((r) => r.url),
    rows,
  };
  await writeFile("etiquette-audit.json", JSON.stringify(report, null, 2));
  console.log("\nWrote etiquette-audit.json");
}

// `void main()` rather than top-level await: tsx transforms this to CJS, where
// top-level await is not available. `prisma/seed.ts` calls its `main()` the
// same way.
void main();
