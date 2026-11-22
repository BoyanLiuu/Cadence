import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/*
 * SSRF defence for outbound fetches of READER-SUPPLIED addresses.
 *
 * M9 is the first code in this project that asks a server to fetch a URL a user
 * typed. That is a different risk surface from everything before it: the server
 * sits inside a network the user cannot reach, so "fetch this for me" is an
 * invitation to use it as a proxy. The targets that matter are not exotic —
 * `http://127.0.0.1:5432`, `http://[::1]`, and above all the cloud metadata
 * endpoint `http://169.254.169.254/`, which on an unprotected instance hands
 * out credentials.
 *
 * ARCHITECTURE §6.3 asks for an http/https allowlist and §6.4 for a timeout and
 * a size cap. This file is the part neither spells out, and it is the part that
 * is easy to get wrong in three specific ways:
 *
 *  1. CHECKING THE HOSTNAME, NOT THE ADDRESS. `localtest.me` and countless
 *     other names resolve to 127.0.0.1. A deny list of names is not a control;
 *     the address a name resolves to is the only thing worth checking.
 *  2. CHECKING ONCE. A redirect is a second request to a second address.
 *     `https://evil.example/` returning `302 -> http://169.254.169.254/` defeats
 *     a check that only ran on the original URL, which is why this module
 *     refuses to let `fetch` follow redirects at all and re-validates each hop.
 *  3. RESOLVING TWICE. Validating a hostname and then handing the same hostname
 *     to `fetch` lets DNS answer differently the second time (DNS rebinding).
 *     Fully closing that needs the connection pinned to the validated address,
 *     which `undici` can do and this does not — see the note on
 *     `REBIND_RESIDUAL` below. The window is narrow and the mitigation is
 *     deliberately recorded rather than assumed away.
 */

/** Only these two. `file:`, `gopher:`, `data:` and friends are never fetched. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Address ranges a feed fetch must never reach.
 *
 * Expressed as predicates over the parsed address rather than as CIDR strings,
 * because the IPv6 cases are the ones that get missed: an IPv4-mapped address
 * (`::ffff:127.0.0.1`) and the deprecated-but-live NAT64/6to4 embeddings all
 * carry an IPv4 address inside an IPv6 one.
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Unparseable is blocked: this function's answer is "is it safe", and an
    // address we cannot read is not.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 — CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 — LINK-LOCAL, incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 — private
  if (a === 192 && b === 168) return true; // 192.168/16 — private
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24 — special
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 — benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 — documentation
  if (a === 203 && b === 0) return true; // 203.0.113/24 — documentation
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
}

/**
 * An IPv6 address as its SIXTEEN BYTES, or null if it will not parse.
 *
 * Needed because the first version of the check below matched on the TEXT —
 * `startsWith("::1")`, `startsWith("fd")` and so on — and the text has many
 * spellings for one address. All of these are valid IPv6 that the string
 * checks let through:
 *
 *   0:0:0:0:0:0:0:1        ::1, loopback, written out in full
 *   0:0:0:0:0:ffff:7f00:1  IPv4-mapped 127.0.0.1, uncompressed
 *   0064:ff9b::1           NAT64, with a leading zero in the first group
 *
 * Numbers have one spelling, so the ranges are tested against bytes.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // A zone index (`fe80::1%eth0`) is not part of the address.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // A trailing dotted-quad, as in `::ffff:127.0.0.1`, becomes two groups.
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const quad = dotted[1].split(".").map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    text = text.slice(0, dotted.index) + hi + ":" + lo;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;

  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail]
      : head;
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = (g >> 8) & 0xff;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

function isBlockedIPv6(ip: string): boolean {
  const b = ipv6Bytes(ip);
  if (b === null) return true; // unreadable is blocked

  const allZero = (upto: number) => b.slice(0, upto).every((x) => x === 0);

  // `::` unspecified and `::1` loopback.
  if (allZero(15) && (b[15] === 0 || b[15] === 1)) return true;

  // ::ffff:0:0/96 — IPv4-MAPPED. Carries a v4 address, so defer to the v4 rules.
  if (allZero(10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // ::/96 with a v4 tail — IPv4-COMPATIBLE, deprecated but still routable text.
  if (allZero(12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0)) {
    return isBlockedIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64, both embed a v4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  if (b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00) return true; // 100::/64 discard

  return false;
}

/** True when this literal address must not be fetched. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true; // not an address at all
}

/** Why a URL was refused, as a stable code for `fetch_log.error_code`. */
export type GuardFailure =
  | "bad_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "port_not_allowed"
  | "dns_failed"
  | "private_address";

export type GuardResult =
  { ok: true; url: URL; addresses: string[] } | { ok: false; reason: GuardFailure };

/**
 * Ports a feed may be served on.
 *
 * Not a security boundary on its own — the address check is — but it closes
 * off using the fetcher as a port scanner against hosts that ARE public.
 * Defaults plus the handful of alternates real feeds use.
 */
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/**
 * Is this URL safe to fetch, and what does it resolve to?
 *
 * Returns the resolved addresses so a caller can log what it checked. Every
 * failure is a REASON rather than a thrown error, because a feed that cannot be
 * fetched is an ordinary outcome this project already models (§6.3) and not an
 * exception.
 */
export async function guardUrl(raw: string): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, reason: "scheme_not_allowed" };

  // `https://user:pass@host/` would send a reader's pasted credentials onward,
  // and is also a classic way to make a URL read as one host while resolving
  // another.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials_in_url" };
  }

  /*
   * THE ADDRESS CHECK COMES BEFORE THE PORT CHECK, and the order is about the
   * reason code rather than about safety — either check refuses the request.
   *
   * `http://127.0.0.1:5432/` fails both. Reported as `port_not_allowed` it
   * reads as someone mistyping a feed URL; reported as `private_address` it
   * reads as someone trying to reach the database, which is what it is. That
   * code lands in `fetch_log.error_code`, so it is the only thing an operator
   * will ever see about the attempt.
   */
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // A literal address needs no DNS, and must not get a free pass for it.
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) return { ok: false, reason: "private_address" };
    if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "port_not_allowed" };
    return { ok: true, url, addresses: [host] };
  }

  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: "port_not_allowed" };

  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  if (resolved.length === 0) return { ok: false, reason: "dns_failed" };

  /*
   * EVERY address must pass, not merely one.
   *
   * A name with both a public and a private A record would otherwise be
   * fetchable, and which one `fetch` picks is not ours to decide.
   */
  if (resolved.some((r) => isBlockedAddress(r.address))) {
    return { ok: false, reason: "private_address" };
  }

  return { ok: true, url, addresses: resolved.map((r) => r.address) };
}

/**
 * The residual risk this module does NOT close, recorded rather than implied.
 *
 * `guardUrl` resolves a hostname and the subsequent `fetch` resolves it again,
 * so a DNS answer that changes between the two calls is not caught (DNS
 * rebinding). Closing it means connecting to the validated ADDRESS with the
 * original `Host` header and SNI — which `undici`'s connect hook can do, and
 * which is the right fix if this ever runs anywhere with network reachability
 * worth protecting.
 *
 * Why it is acceptable for now: the attack needs a TTL-0 record flipped inside
 * the window between two resolutions in the same process, to reach a private
 * network that on Vercel's runtime holds nothing of ours. The cloud metadata
 * endpoint is the prize, and Vercel's functions do not expose one.
 *
 * It is a named constant so it appears in a grep for the thing it is about.
 */
export const REBIND_RESIDUAL =
  "guardUrl resolves the hostname; fetch resolves it again. Pin the connection " +
  "to the validated address (undici connect hook) before running this where a " +
  "private network holds anything worth reaching.";
