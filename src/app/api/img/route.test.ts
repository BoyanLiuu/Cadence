import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signImageUrl } from "@/lib/extract/image-proxy";
import type { FetchOutcome } from "@/lib/ingest/fetch";

/*
 * What this suite is for: an OPEN PROXY, which is what this route is if any one
 * of four things is missing (§6.5).
 *
 * The route fetches an address out of its own query string. Written naively it
 * is a free fetcher using our bandwidth, putting our IP in other people's logs
 * and offering our network an inside view of itself. What stops that is a
 * signature, a guard, a content-type allowlist and a size cap — and the point
 * of this suite is that the FIRST TWO ARE DIFFERENT CHECKS.
 *
 * The signature proves THIS SERVER produced the URL. It says nothing about
 * whether the address is safe, because the addresses we sign come out of
 * publisher HTML — so a correctly-signed `169.254.169.254` is exactly the thing
 * to expect, and "it was signed" must never be a reason to fetch it.
 *
 * ASSERTED ON WHETHER THE FETCHER WAS CALLED, not only on the status code. A
 * 403 returned after the request went out is not a refusal.
 */

const SECRET = "test-image-secret-0123456789abcdef";
const PUBLIC_IMAGE = "http://93.184.216.34/photo.jpg";
const METADATA = "http://169.254.169.254/latest/meta-data/";

/** Every fetch the route attempted, so "never dialled" is observable. */
const calls: string[] = [];
let answer: FetchOutcome;

vi.mock("@/lib/ingest/fetch", () => ({
  fetchFeed: (url: string) => {
    calls.push(url);
    return Promise.resolve(answer);
  },
}));

const bytes = (n: number) => new Uint8Array(n).fill(7);

const imageResponse = (contentType: string | null, size = 128): FetchOutcome => ({
  kind: "changed",
  status: 200,
  body: bytes(size),
  contentType,
  etag: null,
  lastModified: null,
  bodyHash: new Uint8Array(32),
  finalUrl: null,
  landedUrl: PUBLIC_IMAGE,
  bytes: size,
});

/** The route, imported fresh so it reads the current environment. */
async function get(url: string) {
  const { GET } = await import("./route");
  return GET(new Request(url));
}

describe("the image proxy", () => {
  beforeEach(() => {
    calls.length = 0;
    answer = imageResponse("image/jpeg");
    process.env.CADENCE_IMG_SECRET = SECRET;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CADENCE_IMG_SECRET;
  });

  it("serves a signed image, so the refusals below are not vacuous", async () => {
    const signed = signImageUrl(PUBLIC_IMAGE);
    expect(signed, "nothing was signed, so every case below proves nothing").not.toBeNull();

    const response = await get(`https://cadence.test${signed!}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(calls).toEqual([PUBLIC_IMAGE]);
    // `nosniff`, so a browser cannot decide our image is really a document.
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("REFUSES an unsigned address without making a request", async () => {
    // The open-proxy case in its simplest form: a stranger supplying a URL.
    const response = await get(
      `https://cadence.test/api/img?u=${encodeURIComponent(PUBLIC_IMAGE)}`,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("REFUSES a wrong signature without making a request", async () => {
    const response = await get(
      `https://cadence.test/api/img?u=${encodeURIComponent(PUBLIC_IMAGE)}&s=${"0".repeat(64)}`,
    );

    expect(response.status).toBe(403);
    expect(calls, "a forged signature still reached the network").toEqual([]);
  });

  it("REFUSES a signature made with a different secret", async () => {
    /*
     * The case a length or shape check would pass. A signature that is the
     * right size and the wrong key must fail, which is what the HMAC is for —
     * and it is the version of this test that fails if someone ever compares
     * only lengths.
     */
    process.env.CADENCE_IMG_SECRET = "a-completely-different-secret-value";
    const signedElsewhere = signImageUrl(PUBLIC_IMAGE)!;
    process.env.CADENCE_IMG_SECRET = SECRET;
    vi.resetModules();

    const response = await get(`https://cadence.test${signedElsewhere}`);

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("NEVER DIALS a private address, even correctly signed", async () => {
    /*
     * THE CASE THIS WHOLE FILE EXISTS FOR, and the one an HMAC alone gets
     * wrong. The addresses we sign come from publisher HTML, so a feed can
     * advertise the metadata endpoint as an image — and this signature is
     * genuine. "It was signed" is not a reason to fetch something.
     *
     * Signed by hand rather than through `signImageUrl`, because that function
     * refuses this address up front: the point here is that the ROUTE refuses
     * it too, since a signature is replayable and a name can start resolving
     * somewhere else after one was issued.
     */
    const { createHmac } = await import("node:crypto");
    const forged = createHmac("sha256", SECRET).update(METADATA, "utf8").digest("hex");

    const response = await get(
      `https://cadence.test/api/img?u=${encodeURIComponent(METADATA)}&s=${forged}`,
    );

    expect(response.status).toBe(403);
    expect(calls, "a signed private address was fetched").toEqual([]);
  });

  it("REFUSES an extra query parameter, which would be a free amplifier", async () => {
    /*
     * The signature covers `u` and nothing else, so `&n=1`, `&n=2`, `&n=3` all
     * verify — while being three DISTINCT cache keys to a CDN. One signed
     * address becomes unlimited cache-missing requests, each a fresh fetch at
     * the publisher and a fresh function invocation. The signature stops a
     * stranger choosing the ADDRESS; without this it does not stop them
     * choosing how many times we fetch it.
     *
     * Asserted on the fetcher, because the cost is the outbound request.
     */
    const signed = signImageUrl(PUBLIC_IMAGE)!;
    const response = await get(`https://cadence.test${signed}&n=1`);

    expect(response.status).toBe(400);
    expect(calls, "an unsigned parameter still reached the publisher").toEqual([]);
  });

  it("REFUSES to pass through something that is not an image", async () => {
    /*
     * What makes this an IMAGE proxy rather than a proxy. The signature proves
     * we chose the address, not that the publisher serves what they claimed at
     * it — and an HTML page returned through our own origin is a generic
     * fetcher with an image-shaped name.
     */
    answer = imageResponse("text/html; charset=utf-8");
    const response = await get(`https://cadence.test${signImageUrl(PUBLIC_IMAGE)!}`);

    expect(response.status).toBe(415);
    expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
  });

  it("REFUSES an SVG, which is a document rather than a picture", async () => {
    /*
     * SVG carries `<script>`, and served from our own origin it executes in our
     * origin — the stored XSS the sanitiser exists to prevent, arriving through
     * the image path instead of the markup path. A reader loses the occasional
     * diagram; that is the trade, and it is deliberate.
     */
    answer = imageResponse("image/svg+xml");
    const response = await get(`https://cadence.test${signImageUrl(PUBLIC_IMAGE)!}`);

    expect(response.status).toBe(415);
  });

  it("FAILS CLOSED with no secret configured, rather than passing through", async () => {
    const signed = signImageUrl(PUBLIC_IMAGE)!;

    delete process.env.CADENCE_IMG_SECRET;
    vi.resetModules();

    const response = await get(`https://cadence.test${signed}`);

    // 503: the code is fine and the configuration is absent. Not 200, which is
    // what "open until the secret is set" looks like on the first deploy.
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("says NOTHING about why it refused", async () => {
    /*
     * A prober would otherwise learn the difference between a bad signature, a
     * refused address and a host that did not answer — which turns this into an
     * internal port scanner with a two-byte oracle. The `fetch_log` is where an
     * operator looks.
     */
    const response = await get(
      `https://cadence.test/api/img?u=${encodeURIComponent(PUBLIC_IMAGE)}&s=${"0".repeat(64)}`,
    );

    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports an unreachable host as a gateway failure, not as a 200", async () => {
    answer = {
      kind: "failed",
      status: null,
      code: "timeout",
      detail: null,
      retryAfterS: null,
    };
    const response = await get(`https://cadence.test${signImageUrl(PUBLIC_IMAGE)!}`);

    expect(response.status).toBe(502);
  });
});

describe("signing an image address", () => {
  beforeEach(() => {
    process.env.CADENCE_IMG_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.CADENCE_IMG_SECRET;
  });

  it("DROPS the image when no secret is configured", () => {
    /*
     * Null means `sanitizeHtml` removes the element. An unsigned proxy is an
     * open proxy, so the choice is between no image and an open one — and the
     * article is still readable without it.
     */
    delete process.env.CADENCE_IMG_SECRET;
    expect(signImageUrl(PUBLIC_IMAGE)).toBeNull();
  });

  it("SIGNS AN ORDINARY HOSTNAME, which every real image has", () => {
    /*
     * THE BUG THIS SUITE MISSED ENTIRELY. The synchronous pre-check called
     * `isBlockedAddress(url.hostname)`, and that function answers "may this
     * RESOLVED ADDRESS be fetched" — returning TRUE, blocked, for anything
     * that is not an IP literal, because inside `guardUrl` it only ever sees
     * addresses DNS has already produced.
     *
     * So every real image address was refused a signature and `sanitizeHtml`
     * DROPPED EVERY IMAGE FROM EVERY ARTICLE. It failed in the direction that
     * looks like caution, which is why nothing about it looked wrong.
     *
     * Every other case in this file uses a literal IP, chosen so the suite
     * touches no DNS — which also meant it never exercised the only shape a
     * publisher actually uses. This case exists because the cost of that
     * choice has to be paid somewhere.
     */
    expect(signImageUrl("https://harbourwire.example/photo.jpg")).not.toBeNull();
    expect(signImageUrl("http://cdn.example.co.uk/a/b/c.png?v=2")).not.toBeNull();
  });

  it("refuses to sign what should never be fetched", () => {
    // The synchronous half of the guard: no signature is minted for an address
    // the route would refuse anyway, so one cannot sit in stored markup.
    expect(signImageUrl(METADATA)).toBeNull();
    expect(signImageUrl("http://127.0.0.1/x.png")).toBeNull();
    // BRACKETED IPv6, where `URL.hostname` keeps the brackets and `isIP`
    // therefore does not recognise it — so this was signed.
    expect(signImageUrl("http://[::1]/x.png")).toBeNull();
    expect(signImageUrl("http://[fd00::1]/x.png")).toBeNull();
    expect(signImageUrl("file:///etc/passwd")).toBeNull();
    expect(signImageUrl("javascript:alert(1)")).toBeNull();
    expect(signImageUrl("not a url")).toBeNull();
    // And a public one still signs, so this is not refusing everything.
    expect(signImageUrl(PUBLIC_IMAGE)).not.toBeNull();
  });
});
