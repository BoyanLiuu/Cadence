import { canonicalUrl, TRACKING_PARAM_PREFIXES, TRACKING_PARAMS } from "./canonical-url";

/*
 * The arrivals proof, derived rather than described.
 *
 * This is the design's signature element (Appendix E): every address one
 * article arrived under, with the parts canonicalisation set aside struck
 * through in orange, collapsing to one address key.
 *
 * It is computed from the SAME rules `canonicalUrl` applies, so the panel
 * cannot drift from the function it illustrates. A hand-written explanation
 * would eventually describe rules the canonicaliser no longer has — and the
 * one screen a reader consults when they doubt the unread count is the worst
 * possible place to be confidently wrong.
 */

/** One run of a URL, and whether canonicalisation kept it. */
export type UrlPart = { text: string; kept: boolean };

export type UrlRedline = {
  /** The address, split into kept and struck runs, in original order. */
  parts: UrlPart[];
  /** Plain-language names of what was set aside, for the "Set aside:" line. */
  setAside: string[];
  /** The resulting key, or null if the address cannot be keyed at all. */
  key: string | null;
};

/** `utm_source` and friends, named for the copy rather than for the code. */
function describeParam(name: string): string {
  return name;
}

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  if ((TRACKING_PARAMS as readonly string[]).includes(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Splits an address into what the key keeps and what it sets aside.
 *
 * Deliberately a presentation concern and nothing more: the authority on what
 * a key IS remains `canonicalUrl`, which this calls for the `key` field rather
 * than reassembling from the parts. If the two ever disagree, the parts are
 * wrong and the key is right.
 */
export function redlineUrl(input: string): UrlRedline {
  const key = canonicalUrl(input);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { parts: [{ text: input, kept: true }], setAside: [], key };
  }

  const parts: UrlPart[] = [];
  const setAside: string[] = [];

  // -- scheme: always set aside, never rewritten (§6.1).
  parts.push({ text: `${url.protocol}//`, kept: false });
  setAside.push("the scheme");

  // -- userinfo.
  if (url.username !== "") {
    parts.push({ text: `${url.username}${url.password ? ":…" : ""}@`, kept: false });
    setAside.push("the sign-in");
  }

  // -- host, with `www.` and the root dot split out.
  const host = url.hostname;
  if (host.startsWith("www.")) {
    parts.push({ text: "www.", kept: false });
    setAside.push("www.");
    parts.push({ text: host.slice(4).replace(/\.$/, ""), kept: true });
  } else {
    parts.push({ text: host.replace(/\.$/, ""), kept: true });
  }
  if (host.endsWith(".")) {
    parts.push({ text: ".", kept: false });
    setAside.push("the root dot");
  }

  // -- port, kept only when it is not the default.
  if (url.port !== "") {
    parts.push({ text: `:${url.port}`, kept: true });
  }

  // -- path, with a trailing slash split out.
  const trailing = /\/+$/.exec(url.pathname);
  const pathKept = trailing ? url.pathname.slice(0, trailing.index) : url.pathname;
  if (pathKept !== "") parts.push({ text: pathKept, kept: true });
  if (trailing) {
    parts.push({ text: trailing[0], kept: false });
    setAside.push("the trailing slash");
  }

  // -- query, parameter by parameter, so a reader sees which tag went.
  const raw = url.search.replace(/^\?/, "");
  if (raw !== "") {
    const pairs = raw.split("&").filter((p) => p !== "");
    let keptAny = false;
    pairs.forEach((pair, i) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // Keep the raw spelling for matching.
      }
      const tracking = isTracking(decoded);
      /*
       * The separator depends on which run it belongs to, and both directions
       * have a wrong answer:
       *
       *   - A STRUCK parameter keeps its POSITIONAL separator, so a run of
       *     tracking tags reads as the `?utm_source=a&utm_medium=b` the
       *     publisher actually sent. Keying it off survival instead produced
       *     `?utm_source=a?utm_medium=b`.
       *   - A SURVIVING parameter owns `?` only if it is the FIRST survivor.
       *     Using the positional separator instead meant that when the first
       *     parameter was tracking, the `?` was struck along with it and the
       *     kept remainder rendered as `x.example/a&id=5`.
       */
      const lead = tracking ? (i === 0 ? "?" : "&") : keptAny ? "&" : "?";
      parts.push({ text: `${lead}${pair}`, kept: !tracking });
      if (tracking) setAside.push(describeParam(decoded));
      else keptAny = true;
    });
  }

  // -- fragment. Kept only when there is nothing else to key on, which is the
  // one exception `canonicalUrl` makes for client-routed sites.
  if (url.hash !== "" && url.hash !== "#") {
    const fragmentIsIdentity = key !== null && key.includes("#");
    parts.push({ text: url.hash, kept: fragmentIsIdentity });
    if (!fragmentIsIdentity) setAside.push("the fragment");
  }

  return { parts: parts.filter((p) => p.text !== ""), setAside, key };
}

/** "the scheme, www. and utm_source" — an Oxford-free list for the copy. */
export function joinSetAside(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
