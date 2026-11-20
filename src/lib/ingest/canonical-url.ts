/*
 * Rung 2 of the ladder: one URL, one key.
 *
 * ARCHITECTURE Appendix F calls this one of the two files where a bug is
 * SILENT AND PERMANENT. The reasoning is worth restating, because it is what
 * justifies the test count:
 *
 *   - Too LOOSE and two different articles collapse into one row. The second
 *     one is simply never shown. Nobody reports an article they never saw.
 *   - Too STRICT and one article becomes two rows. One is already read, the
 *     other says unread, and the sidebar starts lying — which §6.1 names as
 *     the thing that actually loses readers.
 *
 * Neither failure announces itself, and neither is fixable after the fact: the
 * duplicate rows are already in the table and already read. So the rules are
 * ordered, deterministic, and versioned, and every one of them is pinned by a
 * before/after pair in the tests.
 */

/**
 * The version of THIS ruleset.
 *
 * Bump it whenever any rule below changes — the ordering, the deny list, the
 * encoding normalisation, anything that can change an output. `norm-version
 * .test.ts` fingerprints the ruleset and fails the build if the rules move
 * without this number moving, because a silent ruleset change is the one way
 * to get duplicates with no warning at all.
 *
 * Bumping it is not free: rows distinct under v1 can be EQUAL under v2, so a
 * bump creates duplicates retroactively and requires the replay-and-merge in
 * `src/lib/db/merge.ts` to run in the same migration.
 */
export const NORM_VERSION = 1;

/**
 * Query parameters deleted before hashing.
 *
 * Every one is a tracking or referral tag that identifies *how a reader
 * arrived*, not *which article they arrived at*. `utm_` is a prefix rule; the
 * rest are exact names. Matched case-insensitively, because the same tag
 * appears as `utm_source` and `UTM_SOURCE` in the wild and a case difference
 * is never a different article.
 *
 * Exported so the tests can assert there is a case for each one.
 */
export const TRACKING_PARAM_PREFIXES = ["utm_"] as const;

export const TRACKING_PARAMS = [
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "igshid",
  "ref",
  "source",
  "at_medium",
  "at_campaign",
  "cmp",
  "smid",
  "partner",
] as const;

const DENIED = new Set<string>(TRACKING_PARAMS);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/** Unreserved characters, per RFC 3986: these never need escaping. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Normalises percent-encoding so two spellings of one address agree.
 *
 * `%7Euser` and `~user` are the same path, and `%2f` and `%2F` are the same
 * escape. Without this, a publisher changing their URL generator re-publishes
 * their archive — the same failure mode as rewriting the scheme.
 *
 * Needlessly-escaped unreserved characters are decoded; everything else keeps
 * its escape with the hex digits upper-cased, which is what RFC 3986 specifies.
 * A malformed escape is left exactly as found rather than guessed at.
 */
function normalizeEscapes(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED.test(char) ? char : escape.toUpperCase();
  });
}

/**
 * The canonical key for a URL, or null if it is not one we can key on.
 *
 * The output is deliberately NOT a URL. It is a key — `host/path?query` with
 * no scheme — and nothing should try to fetch it.
 *
 * THE SCHEME IS DROPPED RATHER THAN REWRITTEN. This is the rule most easily got
 * wrong, and §6.1 singles it out: normalising `http` to `https` seems tidier,
 * but then a publisher's TLS migration changes nothing, while a publisher who
 * has NOT migrated and whose feed still carries `http` links would produce keys
 * that no longer match their own archive. Dropping the scheme entirely makes
 * the two indistinguishable, which is the point — `http://x/a` and `https://x/a`
 * are the same article in every case that has ever mattered.
 */
export function canonicalUrl(input: string | null | undefined): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    // Relative or malformed. Resolution is `normalize`'s job and has already
    // happened by the time a URL reaches here; anything still relative cannot
    // be keyed on.
    return null;
  }

  // Only addresses a reader can open. A `javascript:` or `data:` URL has no
  // business being an article identity, and `normalize` already drops them —
  // this is the second line of the same defence.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // -- host: lowercase, no `www.`, no userinfo, no default port, no root dot.
  // `new URL` has already lowercased the host and dropped :80 / :443. The
  // trailing dot of a fully-qualified name is syntax, not a different host:
  // `x.example.` and `x.example` are the same server to every resolver.
  let host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  if (host === "") return null;
  if (url.port !== "") host = `${host}:${url.port}`;

  // -- path: escapes normalised, trailing slash dropped. CASE IS PRESERVED.
  // A path is case-sensitive on most servers, so `/Nov/18/` and `/nov/18/`
  // may genuinely be different documents. Only the host is case-insensitive.
  const path = normalizeEscapes(url.pathname).replace(/\/+$/, "");

  /*
   * -- query: tracking tags deleted, survivors sorted.
   *
   * Sorted because `?a=1&b=2` and `?b=2&a=1` request the same document, and a
   * feed that reorders them on a template change must not re-publish. Sorted
   * by name THEN value, so repeated names are deterministic too.
   *
   * Read from the RAW query string, not from `url.searchParams`, which
   * percent-DECODES. Emitting decoded pairs collapsed `?p=b%26q%3Dc` — ONE
   * parameter whose value contains `&q=c` — with `?p=b&q=c`, which is TWO
   * parameters. Two different addresses, one `url_hash`, and one article
   * silently never shown. Keeping the raw spelling while normalising only the
   * escape CASING preserves the distinction and still makes `%2f` and `%2F`
   * agree. It also stops `%2541` being decoded twice.
   */
  const raw = url.search.replace(/^\?/, "");
  const kept: { name: string; value: string; hadEquals: boolean }[] = [];
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);

    // The deny list matches the DECODED name, so an encoded `utm%5Fsource` is
    // still recognised as tracking.
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      // Malformed escape: fall back to matching the raw spelling.
    }
    if (isTracking(decodedName)) continue;

    kept.push({
      // `+` means a space in a query string, so `?q=hello+world` and
      // `?q=hello%20world` are the same request. Reconciled to one spelling,
      // for the same reason `%2f` and `%2F` are.
      name: normalizeEscapes(rawName.replace(/\+/g, "%20")),
      value: normalizeEscapes(rawValue.replace(/\+/g, "%20")),
      hadEquals: eq !== -1,
    });
  }
  kept.sort((a, b) =>
    a.name === b.name
      ? a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : 0
      : a.name < b.name
        ? -1
        : 1,
  );

  const query = kept.map((p) => (p.hadEquals ? `${p.name}=${p.value}` : p.name)).join("&");

  /*
   * -- fragment: dropped, with ONE exception.
   *
   * `#comments` is a position within a document, never a different document,
   * so §6.1 drops it. But a client-routed site puts the whole address in the
   * fragment — `site.example/#!/2026/11/one` — and there, dropping it leaves
   * EVERY item in the feed keyed as `site.example`. With `UNIQUE(url_hash)` as
   * rung 2, that means only the first item is ever stored and the rest of the
   * feed is silently discarded forever. The "too loose" failure at its worst:
   * nobody reports articles they never saw.
   *
   * So the fragment is kept only when there is nothing else to key on — no
   * path and no query. That cannot affect a normal URL, because a normal URL
   * has a path, and it leaves `#comments` on a real article dropped as
   * specified. A deliberate narrowing of §6.1's rule rather than a
   * reinterpretation of it.
   */
  const identifyingPath = path !== "" || query !== "";
  const fragment = identifyingPath ? "" : normalizeEscapes(url.hash.replace(/^#/, ""));

  const base = query === "" ? `${host}${path}` : `${host}${path}?${query}`;
  return fragment === "" ? base : `${base}#${fragment}`;
}

/**
 * A stable fingerprint of the ruleset, for the version guard.
 *
 * Changing any rule below must change this string. It is deliberately built
 * from the DATA the rules use plus a hand-maintained list of the rule steps,
 * because there is no way to fingerprint code itself — so adding a rule means
 * adding its name here, which is exactly the moment to notice the version
 * needs bumping.
 */
export const RULESET_FINGERPRINT = [
  "drop-scheme",
  "lowercase-host",
  "strip-leading-www",
  "strip-root-dot",
  "drop-userinfo",
  "drop-default-port",
  "normalize-percent-escapes",
  "plus-is-space-in-query",
  "strip-trailing-slash",
  "preserve-path-case",
  "drop-fragment-unless-sole-identity",
  "delete-tracking-params",
  "sort-query-by-name-then-value",
  `prefixes:${TRACKING_PARAM_PREFIXES.join(",")}`,
  `params:${[...TRACKING_PARAMS].sort().join(",")}`,
  // The unreserved set is rule DATA, like the deny list: editing it changes
  // every key. Derived rather than named, so a change cannot slip past.
  `unreserved:${UNRESERVED.source}`,
].join("|");
