import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchHttpForTest, MAX_BODY_BYTES, USER_AGENT, type Validators } from "./fetch";

/*
 * What this suite is for: a poller that gets blocked.
 *
 * §6.4's three politeness rules are the difference between a feed reader and a
 * crawler a sysadmin bans. Each one is easy to believe you have implemented:
 *
 *   - sending validators back, and doing NOTHING on a 304
 *   - noticing an unchanged body from a server that sends no validators
 *   - identifying ourselves, with a contact URL
 *
 * The first is the one that silently stops working. If `If-None-Match` is not
 * sent, the server returns 200 with the whole body every time, everything still
 * WORKS — the ladder collapses it all — and the only evidence is bandwidth
 * nobody is watching. So these tests assert on what was SENT, not just on what
 * came back.
 *
 * Runs a real `node:http` server on LOOPBACK rather than mocking `fetch`,
 * because the behaviour under test is HTTP: status codes, header round-trips,
 * redirects, and a streamed body being cut off at a cap.
 */

type Recorded = { method: string; headers: Record<string, string | string[] | undefined> };

let server: Server;
let base: string;
const received: Recorded[] = [];

/** What the next response should be. Set per test. */
let handler: (
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (body?: string | Buffer) => void;
  },
) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({ method: req.method ?? "", headers: req.headers });
    handler({ headers: req.headers }, res as never);
  });
  await new Promise<void>((resolve) => {
    /*
     * LOOPBACK ONLY. Binding to 127.0.0.1 and not 0.0.0.0 keeps a test fixture
     * off the network — a test server on all interfaces is a listener on every
     * machine that ever runs this suite, including CI.
     */
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const NO_VALIDATORS: Validators = { etag: null, lastModified: null, bodyHash: null };
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>`;

/*
 * These call `fetchHttpForTest`, which is `fetchFeed` with the private-address
 * check swapped for a loopback-permitting one — because the guard refuses
 * loopback, which is exactly what it is for, and the fixture server has to live
 * there. It is the SAME redirect and validator code either way; only the
 * address predicate differs, and the guard itself is covered in
 * `net/guard.test.ts`.
 */

describe("conditional requests", () => {
  it("sends back the validators the server gave us", async () => {
    /*
     * The assertion that catches the silent failure. A poller that never sends
     * `If-None-Match` still works perfectly — the server returns 200 and the
     * ladder collapses the items — so nothing fails except the publisher's
     * bandwidth bill.
     */
    received.length = 0;
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };

    const result = await fetchHttpForTest(`${base}/feed.xml`, {
      etag: 'W/"abc123"',
      lastModified: "Wed, 12 Nov 2026 09:12:00 GMT",
      bodyHash: null,
    });

    expect(result.kind).toBe("unchanged");
    expect(received).toHaveLength(1);
    expect(received[0].headers["if-none-match"]).toBe('W/"abc123"');
    expect(received[0].headers["if-modified-since"]).toBe("Wed, 12 Nov 2026 09:12:00 GMT");
  });

  it("reports a 304 as unchanged, NOT as a failure", async () => {
    // §6.4: a 304 is a SUCCESS. Counting it as a failure would drive the
    // backoff curve on the most common outcome there is.
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    const result = await fetchHttpForTest(`${base}/feed.xml`, {
      etag: '"x"',
      lastModified: null,
      bodyHash: null,
    });
    expect(result.kind).toBe("unchanged");
    if (result.kind === "unchanged") {
      expect(result.status).toBe(304);
      expect(result.soft).toBe(false);
    }
  });

  it("identifies itself with a contact URL", async () => {
    /*
     * An anonymous poller is one a sysadmin can only block. §6.4 asks for a
     * `User-Agent` naming the project with a URL, so a publisher who wants us
     * to stop has someone to tell.
     */
    received.length = 0;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };
    await fetchHttpForTest(`${base}/feed.xml`, NO_VALIDATORS);

    const ua = received[0].headers["user-agent"];
    expect(ua).toBe(USER_AGENT);
    expect(String(ua)).toMatch(/https?:\/\//);
    expect(String(ua)).toContain("Cadence");
  });

  it("returns the new validators so the NEXT poll can be conditional", async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/rss+xml",
        etag: 'W/"fresh"',
        "last-modified": "Thu, 13 Nov 2026 10:00:00 GMT",
      });
      res.end(FEED);
    };
    const result = await fetchHttpForTest(`${base}/feed.xml`, NO_VALIDATORS);
    expect(result.kind).toBe("changed");
    if (result.kind === "changed") {
      expect(result.etag).toBe('W/"fresh"');
      expect(result.lastModified).toBe("Thu, 13 Nov 2026 10:00:00 GMT");
      expect(result.bodyHash.byteLength).toBe(32);
    }
  });

  it("does NOT send a stored validator to a REDIRECT target", async () => {
    /*
     * A validator belongs to the resource that issued it. Sending our `ETag`
     * for feed A to whatever B redirects us to is asking a different server
     * about a token it never minted — at best meaningless, at worst a 304 from
     * a resource we have never actually read.
     */
    received.length = 0;
    let hop = 0;
    handler = (_req, res) => {
      if (hop++ === 0) {
        res.writeHead(301, { location: `${base}/moved.xml` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };

    await fetchHttpForTest(`${base}/feed.xml`, {
      etag: '"original"',
      lastModified: null,
      bodyHash: null,
    });

    expect(received).toHaveLength(2);
    expect(received[0].headers["if-none-match"]).toBe('"original"');
    expect(received[1].headers["if-none-match"]).toBeUndefined();
  });

  it("reports the final URL after a redirect, so it can be persisted", async () => {
    // §6.4 asks for redirect persistence: a permanent redirect followed on
    // every poll forever is a request the publisher should not have to serve.
    let hop = 0;
    handler = (_req, res) => {
      if (hop++ === 0) {
        res.writeHead(301, { location: `${base}/new-home.xml` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };
    const result = await fetchHttpForTest(`${base}/old.xml`, NO_VALIDATORS);
    expect(result.kind).toBe("changed");
    if (result.kind === "changed") expect(result.finalUrl).toBe(`${base}/new-home.xml`);
  });

  it("reports no final URL when there was no redirect", async () => {
    // So the caller does not write `feed_url` on every ordinary poll.
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };
    const result = await fetchHttpForTest(`${base}/feed.xml`, NO_VALIDATORS);
    if (result.kind === "changed") expect(result.finalUrl).toBeNull();
  });

  it("gives up after too many redirects rather than looping", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `${base}/round-and-round.xml` });
      res.end();
    };
    const result = await fetchHttpForTest(`${base}/start.xml`, NO_VALIDATORS);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.code).toBe("too_many_redirects");
  });

  it("REFUSES a body over the cap rather than truncating it", async () => {
    /*
     * Refused, not truncated, and the reason is the ladder. A truncated feed
     * parses into a SHORTER item list, which §6.1 reads as the publisher having
     * deleted the rest — and the cut lands at a different byte each time, so
     * the soft 304 would report a change on every poll forever.
     */
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(Buffer.alloc(MAX_BODY_BYTES + 1024, "x"));
    };
    const result = await fetchHttpForTest(`${base}/huge.xml`, NO_VALIDATORS);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.code).toBe("too_large");
  });

  it("accepts a body that is large but UNDER the cap, compressed or not", async () => {
    /*
     * The other side of the cap, and the case M14's audit turned up.
     *
     * `danluu.com/atom.xml` is 2.0 MiB on the wire and 6.4 MiB DECOMPRESSED,
     * because the author publishes full text of everything. Under the old
     * 2 MiB cap it was permanently unfollowable — a real, popular,
     * well-behaved feed that simply could not be subscribed to.
     *
     * 4 MiB here, so the test says something whether the cap is 8 or larger:
     * what is pinned is that a multi-megabyte feed is ACCEPTED, not the
     * constant.
     */
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>'),
      Buffer.from(
        `<item><title>x</title><description>${"y".repeat(4 * 1024 * 1024)}</description></item>`,
      ),
      Buffer.from("</channel></rss>"),
    ]);
    expect(body.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(body.byteLength).toBeLessThan(MAX_BODY_BYTES);

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(body);
    };
    const result = await fetchHttpForTest(`${base}/big.xml`, NO_VALIDATORS);

    expect(result.kind, "a multi-megabyte feed was refused").toBe("changed");
    if (result.kind === "changed") expect(result.bytes).toBe(body.byteLength);
  }, 30_000);

  it("counts DECOMPRESSED bytes, so a small gzip of a huge body is still refused", async () => {
    /*
     * The `Content-Length` pre-check reads the COMPRESSED size and the cap
     * counts what we HOLD, which are different numbers — `danluu.com` declares
     * 2.0 MiB and expands to 6.4. A cap enforced on the declared length would
     * be trivially bypassed by any publisher who gzips, and highly repetitive
     * XML compresses enormously.
     */
    const huge = Buffer.alloc(MAX_BODY_BYTES + 1024 * 1024, "x");
    const { gzipSync } = await import("node:zlib");
    const squeezed = gzipSync(huge);
    expect(squeezed.byteLength, "the compressed body must look harmless").toBeLessThan(1024 * 1024);

    handler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/rss+xml",
        "content-encoding": "gzip",
        "content-length": String(squeezed.byteLength),
      });
      res.end(squeezed);
    };
    const result = await fetchHttpForTest(`${base}/squeezed.xml`, NO_VALIDATORS);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.code).toBe("too_large");
  }, 30_000);

  it("honours Retry-After on an error, in seconds and as a date", async () => {
    handler = (_req, res) => {
      res.writeHead(429, { "retry-after": "120" });
      res.end();
    };
    const seconds = await fetchHttpForTest(`${base}/busy.xml`, NO_VALIDATORS);
    expect(seconds.kind).toBe("failed");
    if (seconds.kind === "failed") {
      expect(seconds.status).toBe(429);
      expect(seconds.retryAfterS).toBe(120);
    }

    const at = new Date(Date.now() + 300_000).toUTCString();
    handler = (_req, res) => {
      res.writeHead(503, { "retry-after": at });
      res.end();
    };
    const dated = await fetchHttpForTest(`${base}/busy.xml`, NO_VALIDATORS);
    if (dated.kind === "failed") {
      expect(dated.retryAfterS).toBeGreaterThan(280);
      expect(dated.retryAfterS).toBeLessThanOrEqual(300);
    }
  });

  // 20 s: the truncated-body case below can only end via the per-hop timeout,
  // which is 10 s by design.
  it(
    "translates a body read that FAILS mid-stream into a failure",
    { timeout: 20_000 },
    async () => {
      /*
       * The gap that made a resetting feed invisible.
       *
       * Only `fetch()` was wrapped, so a connection reset after the headers threw
       * straight out of `fetchFeed` — past the translation into a `FetchOutcome`,
       * past `recordFailure`, past `recordPoll`. The sweep counted it as failed
       * but the feed got no `fetch_log` row and `consecutive_failures` never
       * moved, so M10's backoff would never see it and a feed that resets every
       * connection would be re-polled at full rate forever.
       *
       * Simulated by declaring a length and then destroying the socket, which is
       * what a reset looks like to the client.
       */
      handler = (_req, res) => {
        const raw = res as unknown as {
          writeHead: (c: number, h?: Record<string, string>) => void;
          write: (chunk: string) => void;
          socket: { destroy: () => void };
        };
        raw.writeHead(200, { "content-type": "application/rss+xml", "content-length": "9999" });
        raw.write("<?xml ver");
        raw.socket.destroy();
      };

      const reset = await fetchHttpForTest(`${base}/reset.xml`, NO_VALIDATORS);
      // A FetchOutcome, not a thrown error — that is the whole assertion. Which
      // STAGE reports it depends on how much the client had buffered when the
      // socket died, so both are accepted; what must never happen is a throw.
      expect(reset.kind).toBe("failed");
      if (reset.kind === "failed") expect(["network", "timeout"]).toContain(reset.code);

      /*
       * And a truncated body that ends cleanly, which fails during the READ
       * rather than during `fetch()` — a declared length the server does not
       * deliver. This is the case the body-read catch exists for.
       */
      handler = (_req, res) => {
        const raw = res as unknown as {
          writeHead: (c: number, h?: Record<string, string>) => void;
          end: (chunk: string) => void;
        };
        raw.writeHead(200, { "content-type": "application/rss+xml", "content-length": "9999" });
        raw.end("<?xml ver");
      };

      const truncated = await fetchHttpForTest(`${base}/short.xml`, NO_VALIDATORS);
      expect(truncated.kind).toBe("failed");
      if (truncated.kind === "failed") {
        expect(["network", "timeout"]).toContain(truncated.code);
        // `body:` proves it came through the BODY-READ catch rather than the
        // `fetch()` one — which is the code path this whole case is about, and
        // the one that used to throw out of `fetchFeed` entirely.
        expect(truncated.detail).toContain("body");
      }
    },
  );

  it("persists a 301 target but NOT a 302's", async () => {
    /*
     * Only 301 and 308 say "stop asking for the old address". 302, 303 and 307
     * are explicitly temporary — a token-bearing CDN URL, a maintenance page, a
     * geo-router — and persisting one overwrites `feeds.feed_url` FOREVER with
     * a URL that was valid for a second. This recorded any 3xx.
     */
    for (const [status, persisted] of [
      [301, true],
      [308, true],
      [302, false],
      [303, false],
      [307, false],
    ] as const) {
      let hop = 0;
      handler = (_req, res) => {
        if (hop++ === 0) {
          res.writeHead(status, { location: `${base}/target-${status}.xml` });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end(FEED);
      };
      const result = await fetchHttpForTest(`${base}/from-${status}.xml`, NO_VALIDATORS);
      expect(result.kind, String(status)).toBe("changed");
      if (result.kind === "changed") {
        if (persisted) expect(result.finalUrl, String(status)).toBe(`${base}/target-${status}.xml`);
        else expect(result.finalUrl, String(status)).toBeNull();
      }
    }
  });

  it("does not persist a chain that is permanent then TEMPORARY", async () => {
    // One temporary hop anywhere makes the endpoint temporary. A 301 to a 302
    // means "this feed moved, and its new home is redirecting you somewhere
    // for now" — the second target is not where to ask next time.
    let hop = 0;
    handler = (_req, res) => {
      if (hop === 0) {
        hop++;
        res.writeHead(301, { location: `${base}/second.xml` });
        res.end();
        return;
      }
      if (hop === 1) {
        hop++;
        res.writeHead(302, { location: `${base}/third.xml` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };
    const result = await fetchHttpForTest(`${base}/first.xml`, NO_VALIDATORS);
    if (result.kind === "changed") expect(result.finalUrl).toBeNull();
  });

  it("reports an HTTP error as a failure, with its status", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const result = await fetchHttpForTest(`${base}/broken.xml`, NO_VALIDATORS);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("http_error");
      expect(result.status).toBe(500);
    }
  });
});

describe("the soft 304", () => {
  it("treats a byte-identical body with NO validators as unchanged", async () => {
    /*
     * §6.4's soft 304. Plenty of feeds send neither an `ETag` nor a
     * `Last-Modified`, so without this every poll of them looks like a change —
     * which would keep the adaptive interval permanently tight and make every
     * poll "measured" for M8's guid-trust detector.
     */
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };

    const first = await fetchHttpForTest(`${base}/no-validators.xml`, NO_VALIDATORS);
    expect(first.kind).toBe("changed");
    if (first.kind !== "changed") return;
    expect(first.etag).toBeNull();
    expect(first.lastModified).toBeNull();

    const second = await fetchHttpForTest(`${base}/no-validators.xml`, {
      etag: null,
      lastModified: null,
      bodyHash: first.bodyHash,
    });
    expect(second.kind).toBe("unchanged");
    if (second.kind === "unchanged") {
      // `soft` distinguishes it from a real 304 in `fetch_log`, because the two
      // say different things about the publisher.
      expect(second.soft).toBe(true);
      expect(second.status).toBe(200);
    }
  });

  it("reports a CHANGED body as changed, so the soft 304 is not a blanket", async () => {
    // The negative case. A soft 304 that fired on everything would stop
    // ingestion entirely and look like a very efficient poller.
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED);
    };
    const first = await fetchHttpForTest(`${base}/changing.xml`, NO_VALIDATORS);
    if (first.kind !== "changed") throw new Error("expected a change");

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED.replace("<title>T</title>", "<title>Different</title>"));
    };
    const second = await fetchHttpForTest(`${base}/changing.xml`, {
      etag: null,
      lastModified: null,
      bodyHash: first.bodyHash,
    });
    expect(second.kind).toBe("changed");
  });
});
