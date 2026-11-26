import { NextResponse } from "next/server";

import {
  IMAGE_SIG_PARAM,
  IMAGE_URL_PARAM,
  imageProxyConfigured,
  imageSignatureValid,
  isAllowedImageType,
} from "@/lib/extract/image-proxy";
import { fetchFeed } from "@/lib/ingest/fetch";
import { guardUrl } from "@/lib/net/guard";

/*
 * `GET /api/img` — the image proxy (§6.5).
 *
 * WHY IT EXISTS. Three reasons, and §6.5 says it earns its place on all three:
 * publishers never see a reader's IP or `Referer`; `http` images stop breaking
 * mixed content on an `https` page; and a hotlinked image that 403s when
 * fetched from a browser can be fetched once from here.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS NOT AN OPEN PROXY
 * ---------------------------------------------------------------------------
 * This is a route that fetches an address from its own query string. Written
 * naively it is a free fetcher with our bandwidth, our IP in other people's
 * logs, and our network's inside view of itself. Four things stand in the way,
 * and all four are necessary:
 *
 *  1. THE SIGNATURE, which proves this server produced the URL. Without it a
 *     stranger supplies any address they like.
 *
 *  2. THE GUARD, which decides whether the address may be fetched at all. The
 *     signature does NOT do this: the addresses we sign come out of publisher
 *     HTML, so a feed can advertise `169.254.169.254` as an image and get a
 *     valid signature for it. `guardUrl` runs here as well as at signing time,
 *     because a signature is replayable and a name can start resolving
 *     somewhere else after it was issued. `fetchFeed` re-guards every redirect
 *     hop on top of that.
 *
 *  3. THE CONTENT-TYPE ALLOWLIST, which is what makes this an IMAGE proxy
 *     rather than a proxy. Without it `?u=<any page>` returns that page
 *     through our origin.
 *
 *  4. THE SIZE CAP, inherited from `fetchFeed` at 2 MB. An unbounded proxy is
 *     a memory exhaustion primitive anyone can fire.
 *
 * FAILS CLOSED on an unconfigured secret: 503, not pass-through. An unsigned
 * proxy is an open proxy, and there is no `NODE_ENV` escape hatch — the same
 * rule `/api/cron/poll` follows and for the same reason.
 *
 * NOT AUTHENTICATED, and that is deliberate rather than overlooked. A
 * `<img src>` is fetched by the browser without the app's session in a way we
 * can rely on across embedding contexts, and the signature already answers the
 * question authentication would: only addresses this server chose can be
 * requested. Sessions add nothing here, because a reader with a session can
 * already see the article the image is in.
 *
 * NO OBJECT STORE. §6.5 says images are cached in R2, which is in no other part
 * of this stack. This passes through with a long `Cache-Control` and lets the
 * CDN absorb repeats, which gives up the third justification above — a
 * repeatedly-403ing hotlink — and keeps the two that matter. Recorded as a
 * deviation in the memo rather than quietly dropped.
 */

export const runtime = "nodejs";

/** A year. These are content-addressed by the signature over the URL. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Refusals say nothing about WHY, for the same reason discovery's do not. */
function refuse(status: number) {
  /*
   * NO BODY AND NO REASON. A prober would otherwise learn the difference
   * between "bad signature", "address refused" and "host did not answer" —
   * which turns this into an internal port scanner with a 2-byte oracle. The
   * `fetch_log` is where an operator looks; the response is not.
   */
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  if (!imageProxyConfigured()) {
    /*
     * LOGGED, because the symptom is every image missing from every article
     * and the cause is one unset variable. `/api/cron/poll` logs its own
     * missing secret for the same reason: a silent 503 is a support question,
     * and the answer is already known here.
     */
    console.error("[img] CADENCE_IMG_SECRET is not set; refusing every request.");
    // 503 rather than 500: the code is fine, the configuration is absent.
    return refuse(503);
  }

  const params = new URL(request.url).searchParams;
  const target = params.get(IMAGE_URL_PARAM);
  const signature = params.get(IMAGE_SIG_PARAM);

  if (target === null || signature === null) return refuse(400);

  /*
   * NO OTHER PARAMETERS, and this closes the amplifier the signature leaves
   * open. The signature covers `u` and nothing else, so `&n=1`, `&n=2`, `&n=3`
   * all verify — while being three DISTINCT cache keys to the CDN. That turns
   * one signed address into unlimited cache-missing requests, each one a fresh
   * fetch at the publisher and a fresh function invocation, which is exactly
   * the amplification the proxy was supposed to prevent being useful.
   *
   * Refused rather than ignored, because ignoring them is what made them free.
   * Signing the whole query string would also work and would bind this route's
   * cache behaviour into its signature format; refusing is simpler and leaves
   * nothing to reason about.
   */
  if ([...params.keys()].some((key) => key !== IMAGE_URL_PARAM && key !== IMAGE_SIG_PARAM)) {
    return refuse(400);
  }

  // THE SIGNATURE FIRST, before any work and certainly before any lookup. An
  // unsigned request must not be able to make this server resolve a name.
  if (!imageSignatureValid(target, signature)) return refuse(403);

  const guard = await guardUrl(target);
  if (!guard.ok) return refuse(403);

  const outcome = await fetchFeed(guard.url.href);
  if (outcome.kind !== "changed") return refuse(502);

  const contentType = outcome.contentType;
  if (!isAllowedImageType(contentType)) {
    /*
     * A SIGNED ADDRESS THAT TURNED OUT NOT TO BE AN IMAGE. Refused rather than
     * passed through: the signature says we chose the address, not that the
     * publisher serves what they claimed at it — and an HTML page returned
     * through our own origin is the hole this check exists to close.
     */
    return refuse(415);
  }

  return new NextResponse(new Uint8Array(outcome.body), {
    status: 200,
    headers: {
      /*
       * Non-null by here: `isAllowedImageType` returns false for null, so the
       * 415 above has already refused it. The `?? "application/octet-stream"`
       * this replaced was unreachable, and an unreachable fallback reads as a
       * case someone considered possible.
       */
      "Content-Type": contentType!,
      "Content-Length": String(outcome.body.byteLength),
      "Cache-Control": CACHE_CONTROL,
      /*
       * `nosniff` so a browser cannot decide our `image/png` is really HTML and
       * run it. Belt and braces over the allowlist above, and the cheaper of
       * the two to be sure of.
       */
      "X-Content-Type-Options": "nosniff",
      // Nothing here is a document, so nothing should be treated as one.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
