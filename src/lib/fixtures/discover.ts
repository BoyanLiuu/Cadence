import type { DiscoveryResult } from "@/lib/types";

import { discovery, SAMPLE_ADDRESSES } from "./index";

/*
 * The five discovery branches, one sample address each.
 *
 * The prototype does exactly this, and the reason is in M5's test requirement:
 * the four FAILURE branches must each render their own designed message rather
 * than one shared error. "Something went wrong" is the easy answer and it is
 * useless — a reader who pasted a site with no feed, a site that timed out,
 * and a feed they already follow needs three different next actions.
 *
 * `discoverFeeds` resolves addresses through here at M5 and over the network at
 * M12. The shape it returns does not change between them.
 */

/**
 * The address as the lookup key: scheme dropped, `www.` dropped, trailing
 * slash dropped.
 *
 * Deliberately NOT `canonicalUrl`. That produces an article identity key and
 * strips tracking parameters; this only has to match what a person typed
 * against the sample list, and `tidewaterletters.example` is what they type.
 */
export function discoveryKey(input: unknown): string {
  // Typed `unknown` on purpose: this value comes from a request body, and §3
  // requires untrusted input to be validated on the server. A non-string used
  // to crash with `input.trim is not a function`, which a 500 the cron route
  // and the add-feed form both have to not produce.
  if (typeof input !== "string") return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Is this something a person could plausibly have meant as an address?
 *
 * The fourth failure branch, and the only one that needs no lookup. Checked
 * before the map so a typo gets "that is not an address" rather than "no feed
 * found there", which would send the reader looking for a feed that was never
 * the problem.
 */
export function looksLikeAddress(input: unknown): boolean {
  const key = discoveryKey(input);
  if (key === "") return false;
  // A host needs a dot and no spaces. Anything else is a search term, a
  // sentence, or a mistake.
  if (/\s/.test(key)) return false;
  const host = key.split("/")[0];
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

/** The addresses the add-feed screen offers, one per branch. */
export const sampleAddresses: { address: string; branch: string }[] = [
  { address: SAMPLE_ADDRESSES[0], branch: "two feeds at one address" },
  { address: SAMPLE_ADDRESSES[1], branch: "a direct feed address" },
  { address: SAMPLE_ADDRESSES[2], branch: "a feed you already follow" },
  { address: SAMPLE_ADDRESSES[3], branch: "a site with no feed" },
  { address: SAMPLE_ADDRESSES[4], branch: "a site that does not answer" },
];

/**
 * Resolves an address against the sample map.
 *
 * An address that is not in the map is reported as `none` rather than thrown:
 * at M5 the map IS the web, so "nothing found there" is the honest answer for
 * anything outside it, and it is the same answer M12 will give for a real site
 * with no feed.
 */
export function resolveSample(input: unknown): DiscoveryResult {
  if (!looksLikeAddress(input)) {
    return {
      kind: "invalid",
      reason: "That does not look like an address. Try something like example.com/feed.",
    };
  }

  const found = discovery[discoveryKey(input)];
  if (found) return found;

  return {
    kind: "none",
    reason:
      "Nothing at that address answered as a feed. In this build only the sample addresses below resolve.",
  };
}
