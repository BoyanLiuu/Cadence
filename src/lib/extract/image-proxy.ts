import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { isBlockedAddress } from "@/lib/net/guard";

/*
 * Signing the image proxy's addresses (§6.5).
 *
 * WHAT THE SIGNATURE IS FOR, and what it is NOT for. It proves this server
 * produced the URL, so a stranger cannot point `/api/img` at an address of
 * their choosing and use it as a free open proxy — our bandwidth, our IP in
 * somebody else's logs.
 *
 * IT SAYS NOTHING ABOUT WHETHER THE ADDRESS IS SAFE TO FETCH. The addresses we
 * sign come out of publisher HTML, so a feed can advertise
 * `http://169.254.169.254/latest/meta-data/` as an image and we will sign it
 * quite happily. The signature answers "who asked", and the guard answers
 * "what may be asked for" — two questions, two mechanisms, and conflating them
 * is how an HMAC becomes security theatre. So `guardUrl` runs when the URL is
 * signed AND again when it is fetched: the first stops a bad address getting a
 * signature at all, the second because a signature is replayable and DNS can
 * move underneath it.
 *
 * FAILS CLOSED. With `CADENCE_IMG_SECRET` unset there is no signing key, so
 * `signImageUrl` returns null and every image is DROPPED from the article
 * rather than served unsigned. An unsigned proxy is an open proxy, and "it will
 * be configured before deploy" describes every secret that ever shipped unset.
 */

/**
 * The most we will proxy for one image. Deliberately NOT the feed cap.
 *
 * SMALLER, AND FOR DIFFERENT REASONS. `MAX_BODY_BYTES` is 8 MiB because the
 * sweep runs six concurrent polls against a function's memory. This route is
 * unauthenticated, has no concurrency bound of its own, and its response has
 * to fit the serverless reply limit — Vercel's is 4.5 MB, so an 8 MiB image
 * would be fetched and buffered in full only to fail at the edge.
 *
 * Raising the feed cap at M14 silently raised this one too, because the route
 * simply called `fetchFeed` and inherited whatever it used. Found in review.
 * 2 MiB is more than any article illustration needs and well inside the reply
 * limit, so a refusal here is a photograph nobody will miss rather than an
 * article nobody can read.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Query parameter names, short because they appear in every `<img src>`. */
export const IMAGE_URL_PARAM = "u";
export const IMAGE_SIG_PARAM = "s";

/**
 * The signing key, or null when none is configured.
 *
 * READ PER CALL rather than captured at module load. A module-level constant is
 * evaluated once per process, which in a serverless runtime means a cold start
 * can capture an empty value and keep it for the life of the instance — and the
 * tests need to set and unset it.
 */
function secret(): string | null {
  const value = process.env.CADENCE_IMG_SECRET;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Whether the proxy can operate at all. */
export function imageProxyConfigured(): boolean {
  return secret() !== null;
}

/**
 * The signature for one absolute address.
 *
 * SIGNS THE EXACT STRING THAT WILL BE FETCHED. An earlier shape signed a
 * normalised form and fetched the raw one, which means the signature covers
 * something other than the request — and anything the normaliser ignored
 * becomes a free parameter an attacker controls.
 */
function sign(url: string, key: string): string {
  return createHmac("sha256", key).update(url, "utf8").digest("hex");
}

/**
 * `/api/img?u=…&s=…` for an absolute address, or null if it cannot be signed.
 *
 * Null for an unconfigured secret, which drops the image. The caller is
 * `sanitizeHtml`'s `rewriteImage`, whose contract is exactly that.
 */
export function signImageUrl(absolute: string): string | null {
  const key = secret();
  if (key === null) return null;

  /*
   * REFUSED WITHOUT A LOOKUP, at signing time, in addition to the route's own
   * guard. This is the SYNCHRONOUS half of the check: `guardUrl` resolves the
   * name and is async, and `sanitizeHtml` walks a DOM synchronously — so the
   * part that can be done from the string alone is done here, and the part
   * that needs DNS is done by the route before it fetches.
   *
   * What this catches is the obvious half and the half that should never get a
   * signature at all: a scheme that is not http(s), and a literal private or
   * loopback address. `net/guard.ts` owns the real rules; this reuses its
   * address test rather than writing a second opinion about what is private.
   */
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  /*
   * ONLY WHEN THE HOST IS AN IP LITERAL, and that condition is the whole bug
   * this line used to be.
   *
   * `isBlockedAddress` answers "may this RESOLVED ADDRESS be fetched" and
   * returns TRUE — blocked — for anything that is not an IP, because within
   * `guardUrl` it only ever sees addresses DNS has already produced, and there
   * "not an address at all" can only mean something has gone wrong.
   *
   * Handing it a hostname is a category error, and it failed in the direction
   * that looks like caution: every real image address was refused a signature,
   * so `sanitizeHtml` dropped EVERY IMAGE FROM EVERY ARTICLE. Not one test
   * caught it, because every address in this suite is a literal IP — chosen so
   * the tests touch no DNS, which also meant they never exercised the only
   * shape a real publisher uses.
   *
   * So the division of labour is explicit: this is the check that can be made
   * from the STRING, and the route's `guardUrl` is the one that resolves the
   * name and checks every address it gets back. A hostname passing here has
   * not been approved; it has been deferred.
   */
  /*
   * BRACKETS STRIPPED FIRST. `URL.hostname` keeps them for IPv6 —
   * `http://[::1]/` gives `[::1]` — and `isIP("[::1]")` is 0, so without this
   * a literal loopback IPv6 address was not recognised as an IP at all, fell
   * through to the deferred branch, and was SIGNED. `guardUrl` would still
   * have refused it at fetch time, but a signature that should never have
   * existed is one sitting in stored markup waiting for the guard to change.
   */
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && isBlockedAddress(host)) return null;

  return `/api/img?${IMAGE_URL_PARAM}=${encodeURIComponent(absolute)}&${IMAGE_SIG_PARAM}=${sign(absolute, key)}`;
}

/**
 * Whether a signature matches, in constant time.
 *
 * `a === b` on strings returns as soon as two bytes differ, so the time taken
 * reveals how long a correct prefix was — enough to forge a signature a byte at
 * a time over many requests. `timingSafeEqual` needs equal lengths, and
 * comparing lengths first would leak the length, so both sides are run through
 * the HMAC again to a fixed width. The same reasoning as `/api/cron/poll`'s
 * `secretMatches`, which is where this was worked out.
 */
export function imageSignatureValid(url: string, signature: string): boolean {
  const key = secret();
  if (key === null) return false;
  if (typeof url !== "string" || typeof signature !== "string") return false;

  const expected = createHmac("sha256", key).update(sign(url, key), "utf8").digest();
  const provided = createHmac("sha256", key).update(signature, "utf8").digest();

  return timingSafeEqual(expected, provided);
}

/**
 * The content types the proxy will pass through.
 *
 * AN ALLOWLIST, AND IT IS WHAT MAKES THIS AN IMAGE PROXY RATHER THAN A PROXY.
 * Without it, `/api/img?u=<any html page>` returns that page's bytes through
 * our origin — which is a generic fetcher with an image-shaped name, and the
 * exact thing the signature was supposed to prevent being useful.
 *
 * NO `image/svg+xml`. SVG is a document: it carries `<script>`, and served from
 * our own origin it would execute in our origin — the stored-XSS the sanitiser
 * exists to prevent, arriving through the image path instead of the markup
 * path. A reader loses the occasional diagram; that is the trade.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
];

/** Whether a response's `Content-Type` is an image this will serve. */
export function isAllowedImageType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== "string") return false;
  // Parameters stripped: `image/jpeg; charset=binary` is still `image/jpeg`.
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.includes(type);
}
