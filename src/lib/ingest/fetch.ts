import { createHash } from "node:crypto";

import { guardUrl, type GuardFailure, type GuardResult } from "@/lib/net/guard";

/*
 * Fetching one feed, politely, from an address a reader supplied.
 *
 * ARCHITECTURE §6.4. Three things make a poller a good citizen rather than a
 * crawler that gets blocked, and all three are here:
 *
 *   CONDITIONAL REQUESTS  send back the validators the server gave us, and do
 *                         NOTHING at all on a 304 — not even a timestamp on the
 *                         article rows. Most polls should cost both sides one
 *                         small request.
 *   A SOFT 304            a byte-identical body from a server that sent no
 *                         validators is still unchanged. Compared on a hash of
 *                         the body, because plenty of feeds send neither an
 *                         `ETag` nor a `Last-Modified`.
 *   IDENTIFYING OURSELVES a `User-Agent` naming the project with a contact URL,
 *                         so a publisher who wants us to stop has someone to
 *                         tell. An anonymous poller is one a sysadmin can only
 *                         block.
 *
 * Plus the limits that stop one bad response taking the sweep down: a 10-second
 * timeout and a body cap, both from §6.4. The cap moved to 8 MiB at M14; see
 * `MAX_BODY_BYTES` for the arithmetic and for what it does NOT bound.
 */

/** Named so it is greppable, and so the contact URL cannot drift silently. */
export const USER_AGENT =
  "Cadence/0.1 (+https://github.com/BoyanLiuu/Cadence) personal feed reader";

/** Per HOP. A redirect chain gets a fresh one, bounded by the total below. */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * The whole poll's ceiling, redirects and body read included.
 *
 * The per-hop timeout alone is not a bound on a poll: five redirects at 10
 * seconds each plus a slow body is a minute, and the lease is 120 seconds —
 * which a per-host queue wait eats into as well. A poll that outlives its lease
 * is the double fetch the lease exists to prevent, so the poll has to be the
 * thing that is bounded.
 *
 * 25 s leaves the 120-second lease most of its margin even with a queue wait in
 * front of it.
 */
export const FETCH_TOTAL_MS = 25_000;
/**
 * The most DECOMPRESSED body we will read, and a feed over it is refused rather
 * than truncated. Raised from 2 MiB to 8 MiB at M14.
 *
 * WHY IT MOVED. M14's etiquette audit found `danluu.com/atom.xml` permanently
 * unfollowable: it is 2.0 MiB over the wire and **6.4 MiB decompressed**,
 * because the author publishes full text of everything. That is a real,
 * popular, well-behaved feed, and the old cap made it impossible to subscribe
 * to — not failing with an explanation, just failing.
 *
 * WHY 8 AND NOT MORE. The cap bounds what one poll HOLDS IN MEMORY, and the
 * sweep runs `HTTP_CONCURRENCY` of them at once:
 *
 *   6 concurrent × 8 MiB   = 48 MiB of body buffers
 *   ×2 transiently          = 96 MiB, while `readCapped` copies its chunk list
 *                             into one contiguous array
 *
 * against a Vercel function's 1 024 MiB. That leaves room, and the honest
 * caveat is that the cap does NOT bound the expensive part: `parse` turns that
 * XML into JS objects at roughly 3–5× the source, so six 8 MiB feeds parsing
 * together is nearer 200 MiB than 48. Raising this further is a decision about
 * the parser's peak, not about the buffer.
 *
 * A CAP MUST EXIST whatever its value — an unbounded read is a memory
 * exhaustion primitive any publisher can fire — so there will always be feeds
 * beyond it. `too_large` is a first-class `fetch_log` code for exactly that
 * reason: the reader is told the feed is bigger than Cadence will fetch,
 * rather than that it could not be read.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Redirect hops followed. Each one is re-validated by the guard. */
export const MAX_REDIRECTS = 5;

/** What we stored last time, and send back to ask "has it changed?". */
export type Validators = {
  etag: string | null;
  lastModified: string | null;
  /** Hash of the last body, for the soft 304. */
  bodyHash: Uint8Array | null;
};

export type FetchOutcome =
  /** New bytes to parse. */
  | {
      kind: "changed";
      status: number;
      body: Uint8Array;
      contentType: string | null;
      etag: string | null;
      lastModified: string | null;
      bodyHash: Uint8Array;
      /** Set when the redirect chain ended somewhere else, and is persisted. */
      finalUrl: string | null;
      /**
       * Where the body actually came from, after every hop. ALWAYS set.
       *
       * Distinct from `finalUrl`, which is the PERSISTENCE signal and is only
       * set for a chain that was permanent all the way through — a 302 must not
       * move `feeds.feed_url`. Discovery needs the other question answered:
       * relative hrefs in a page resolve against where the page was served
       * from, whatever the redirect's permanence. Reading `finalUrl` for that
       * silently used the TYPED address after any temporary redirect, so a site
       * that bounces `/` to `/blog/` had its feed looked for on the wrong path.
       */
      landedUrl: string;
      durationMs: number;
      bytes: number;
    }
  /** Nothing to do. `soft` means the server did not say so; we noticed. */
  | { kind: "unchanged"; status: number; soft: boolean; durationMs: number }
  /** A real failure, with a stable code for `fetch_log.error_code`. */
  | {
      kind: "failed";
      status: number | null;
      code: FetchFailure;
      detail: string | null;
      durationMs: number;
      /** `Retry-After`, in seconds, when the server sent one. */
      retryAfterS: number | null;
    };

export type FetchFailure =
  GuardFailure | "timeout" | "network" | "too_many_redirects" | "too_large" | "http_error";

/** `Retry-After` is either a number of seconds or an HTTP date. Both are honoured. */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((at - now) / 1000));
}

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

/**
 * Reads a response body, refusing anything over the cap.
 *
 * Streamed and counted rather than buffered with `arrayBuffer()`, because the
 * point of a cap is to stop allocating BEFORE the whole thing is in memory. A
 * `Content-Length` is checked first when present, which refuses the common case
 * without transferring anything.
 *
 * REFUSED, not truncated. A truncated feed parses into a SHORTER item list,
 * which §6.1 would read as the publisher having deleted the rest — and a
 * truncated body hashes differently every time the cut lands mid-chunk, so the
 * soft 304 would report change on every poll forever.
 */
async function readCapped(
  response: Response,
  /**
   * The cap for THIS call, so a caller with a different budget can say so.
   *
   * Added at M14, when raising the feed cap to 8 MiB silently raised the IMAGE
   * PROXY's too — a route that is unauthenticated, has no concurrency bound of
   * its own, and whose response has to fit a serverless function's own reply
   * limit. The feed cap is a decision about the sweep's six concurrent polls;
   * the image cap is a decision about an open endpoint. They are not the same
   * number and should not have been one.
   */
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array | "too_large"> {
  /*
   * A CHEAP PRE-CHECK, AND IT COMPARES DIFFERENT UNITS. `Content-Length` is
   * the bytes ON THE WIRE — compressed, for every feed that offers gzip —
   * while the cap below counts DECOMPRESSED bytes, because that is what we
   * hold. So this rejects early when a server is honest about a huge body, and
   * it cannot be relied on: `danluu.com` declares 2.0 MiB and expands to 6.4.
   * The streaming count is the real bound; this only saves reading a body we
   * already know is too big.
   */
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return "too_large";
  }

  if (response.body === null) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Fetches a feed, following redirects BY HAND.
 *
 * `redirect: "manual"` is the security-relevant part, not a style choice. The
 * guard validates an address, and a redirect is a request to a DIFFERENT
 * address — so letting `fetch` follow them means exactly one hop was checked
 * and the rest were not. `302 -> http://169.254.169.254/` is the whole attack.
 * Each hop goes back through `guardUrl`.
 */
export async function fetchFeed(
  feedUrl: string,
  validators: Validators = { etag: null, lastModified: null, bodyHash: null },
  now: Date = new Date(),
  /**
   * How each hop is validated. Defaults to the real SSRF guard.
   *
   * A parameter rather than an env-var bypass, and it exists for one reason:
   * the guard refuses loopback, which is exactly right, and the HTTP behaviour
   * under test here — validator round-trips, redirect chains, a streamed body
   * hitting the cap — can only be exercised against a loopback server.
   *
   * Injecting it keeps ONE code path, so the redirect loop the tests exercise
   * is the production loop. The default is the real guard, every production
   * caller takes the default, and `net/guard.test.ts` covers the guard itself.
   * There is no ambient way to turn this off.
   */
  validate: (url: string) => Promise<GuardResult> = guardUrl,
  /** Overrides `MAX_BODY_BYTES` for this call; see `readCapped`. */
  maxBytes: number = MAX_BODY_BYTES,
): Promise<FetchOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const remaining = () => FETCH_TOTAL_MS - elapsed();

  let target = feedUrl;
  let redirects = 0;
  let redirected = false;
  /*
   * Where a PERMANENT redirect landed, which is not the same as "we were
   * redirected".
   *
   * Only 301 and 308 say "stop asking for the old address". 302, 303 and 307
   * are explicitly temporary — a token-bearing CDN URL, a maintenance page, a
   * geo-router — and persisting one of those overwrites `feeds.feed_url`
   * FOREVER with a URL that was only ever valid for that second. Earlier this
   * recorded any 3xx, which is the bug.
   */
  let permanentTarget: string | null = null;

  for (;;) {
    const guard = await validate(target);
    if (!guard.ok) {
      return {
        kind: "failed",
        status: null,
        code: guard.reason,
        detail: target === feedUrl ? null : `after redirect to ${target}`,
        durationMs: elapsed(),
        retryAfterS: null,
      };
    }

    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml, " +
        "application/feed+json, application/json;q=0.9, */*;q=0.5",
      "accept-encoding": "gzip, deflate, br",
    };
    // Only on the FIRST request. A validator belongs to the resource that
    // issued it, and sending it to a redirect target is asking a different
    // server about an ETag it never minted.
    if (!redirected) {
      if (validators.etag !== null) headers["if-none-match"] = validators.etag;
      if (validators.lastModified !== null) headers["if-modified-since"] = validators.lastModified;
    }

    if (remaining() <= 0) {
      return {
        kind: "failed",
        status: null,
        code: "timeout",
        detail: `poll exceeded ${FETCH_TOTAL_MS} ms`,
        durationMs: elapsed(),
        retryAfterS: null,
      };
    }

    let response: Response;
    try {
      response = await fetch(guard.url, {
        method: "GET",
        headers,
        redirect: "manual",
        // The SMALLER of the per-hop timeout and what is left of the whole
        // poll, so a chain of slow hops cannot add up past the total.
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining())),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "failed",
        status: null,
        code: timedOut ? "timeout" : "network",
        detail: error instanceof Error ? error.name : null,
        durationMs: elapsed(),
        retryAfterS: null,
      };
    }

    // ---- 304: the cheap, common, correct case. Write NOTHING.
    if (response.status === 304) {
      return { kind: "unchanged", status: 304, soft: false, durationMs: elapsed() };
    }

    // ---- A redirect. Validate the next hop rather than trusting it.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        return {
          kind: "failed",
          status: response.status,
          code: "http_error",
          detail: "redirect with no Location",
          durationMs: elapsed(),
          retryAfterS: null,
        };
      }
      if (++redirects > MAX_REDIRECTS) {
        return {
          kind: "failed",
          status: response.status,
          code: "too_many_redirects",
          detail: null,
          durationMs: elapsed(),
          retryAfterS: null,
        };
      }
      // Resolved against the CURRENT hop, because `Location` may be relative.
      target = new URL(location, guard.url).toString();
      redirected = true;
      // 301 Moved Permanently, 308 Permanent Redirect. A chain that is
      // permanent all the way through is persistable; one temporary hop
      // anywhere in it makes the endpoint temporary, so the record is dropped.
      permanentTarget =
        (response.status === 301 || response.status === 308) &&
        (redirects === 1 || permanentTarget !== null)
          ? target
          : null;
      continue;
    }

    if (!response.ok) {
      return {
        kind: "failed",
        status: response.status,
        code: "http_error",
        detail: null,
        durationMs: elapsed(),
        retryAfterS: parseRetryAfter(response.headers.get("retry-after"), now.getTime()),
      };
    }

    /*
     * The body read is INSIDE a try as well, and that was a real gap.
     *
     * Only `fetch()` was wrapped, so a connection reset mid-body, or a stream
     * that stalls past the deadline, threw straight out of `fetchFeed` — past
     * `pollOne`'s translation into a `FetchOutcome`, past `recordFailure`, past
     * `recordPoll`. The sweep's own catch counted it as failed, but the feed got
     * no `fetch_log` row and `consecutive_failures` never moved, so M10's
     * backoff would never see it and a feed that resets every connection would
     * be re-polled at full rate forever.
     */
    let body: Uint8Array | "too_large";
    try {
      body = await readCapped(response);
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "failed",
        status: response.status,
        code: timedOut ? "timeout" : "network",
        detail: error instanceof Error ? `body: ${error.name}` : "body read failed",
        durationMs: elapsed(),
        retryAfterS: null,
      };
    }

    if (body === "too_large") {
      return {
        kind: "failed",
        status: response.status,
        code: "too_large",
        detail: `over ${maxBytes} bytes`,
        durationMs: elapsed(),
        retryAfterS: null,
      };
    }

    const bodyHash = sha256(body);

    /*
     * ---- THE SOFT 304.
     *
     * The server did not say "not modified" — plenty send no validators at all
     * — but the bytes are identical, so there is nothing to do. §6.4 counts
     * this as unchanged, which matters twice over: it keeps the adaptive
     * interval honest, and it is why most polls measure nothing for M8's
     * guid-trust detector.
     */
    if (validators.bodyHash !== null && equalBytes(bodyHash, validators.bodyHash)) {
      return { kind: "unchanged", status: response.status, soft: true, durationMs: elapsed() };
    }

    return {
      kind: "changed",
      status: response.status,
      body,
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      bodyHash,
      // Persisted so the next poll starts where this one ended, as §6.4 asks —
      // a permanent redirect followed on every poll forever is a request the
      // publisher should not have to serve twice. Null for a TEMPORARY
      // redirect, however many hops: see `permanentTarget`.
      finalUrl: permanentTarget,
      landedUrl: target,
      durationMs: elapsed(),
      bytes: body.byteLength,
    };
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `fetchFeed` with the address check replaced by a loopback-permitting one.
 *
 * FOR TESTS ONLY, and it does not weaken the production path: the real
 * `fetchFeed` defaults to `guardUrl` and nothing in `src/app` or
 * `src/lib/schedule` passes this.
 *
 * It enforces the SCHEME and nothing else. An earlier version of this comment
 * claimed the port and credential rules too, which was simply untrue — the
 * validator below is four lines. Those rules are covered where they belong, in
 * `net/guard.test.ts` against the real guard; this exists so the HTTP
 * behaviour can be exercised against a loopback fixture server, which the real
 * guard correctly refuses.
 */
export async function fetchHttpForTest(
  feedUrl: string,
  validators: Validators,
  now: Date = new Date(),
): Promise<FetchOutcome> {
  return fetchFeed(feedUrl, validators, now, async (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, reason: "scheme_not_allowed" };
      }
      return { ok: true, url, addresses: [url.hostname] };
    } catch {
      return { ok: false, reason: "bad_url" };
    }
  });
}
