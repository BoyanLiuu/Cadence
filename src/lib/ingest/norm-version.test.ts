import { describe, expect, it } from "vitest";

import {
  NORM_VERSION,
  RULESET_FINGERPRINT,
  TRACKING_PARAM_PREFIXES,
  TRACKING_PARAMS,
} from "./canonical-url";
import {
  CONTENT_HASH_FINGERPRINT,
  CONTENT_HASH_PREFIX_CHARS,
  CONTENT_HASH_VERSION,
} from "./content-hash";

/*
 * What this suite is for: a silent ruleset change.
 *
 * Editing a canonicalisation rule without bumping `NORM_VERSION` is the one
 * way to get duplicates with NO warning at all. Nothing fails, nothing logs,
 * and the next poll starts writing second rows for articles already in the
 * table — because the stored hashes were produced by rules that no longer
 * exist and nothing records that.
 *
 * So the rules are fingerprinted and the fingerprint is committed. Changing a
 * rule fails this suite, and the only way to make it pass is to update the
 * fingerprint — which is the moment to ask whether every stored `url_hash`
 * has just been invalidated and whether `db/merge.ts` needs to run.
 */

describe("the ruleset version", () => {
  it("is pinned to a committed number", () => {
    expect(NORM_VERSION).toBe(1);
  });

  it("is a positive integer, because it is stored in a SMALLINT column", () => {
    expect(Number.isInteger(NORM_VERSION)).toBe(true);
    expect(NORM_VERSION).toBeGreaterThan(0);
  });
});

describe("the ruleset fingerprint", () => {
  it("is pinned to a committed value", () => {
    // READ THIS BEFORE CHANGING THE VALUE BELOW.
    //
    // This failing means a canonicalisation rule changed. Updating the string
    // is not the fix on its own — ask first:
    //
    //   1. Can the change make two previously-distinct URLs equal? If so,
    //      every affected pair is now a duplicate IN THE TABLE, and the bump
    //      must ship with the replay-and-merge from `src/lib/db/merge.ts` in
    //      the same migration (§6.1).
    //   2. Bump `NORM_VERSION` in the same commit, so stored rows record which
    //      ruleset produced them.
    //
    // Only then update this string.
    //
    // THE ONE EXEMPTION, and it applies right now: if no row has EVER been
    // hashed with the outgoing rules, the version stays put and only this
    // string moves.
    //
    // Not laziness — bumping would be actively worse. A version number that
    // was never used is a FALSE HISTORY. Someone tracing a duplicate in a
    // year's time who finds `norm_version` starting at 2 will go looking for
    // the v1 rows and the v1->v2 merge that produced them, and there are none;
    // nothing anywhere records that v1 was discarded before it ever ran. So
    // version 1 means "the rules the first stored row was hashed with", which
    // is the only meaning that helps anybody.
    //
    // This holds only until M6 creates the schema. These rules changed three
    // times during M3's own review with no database in existence; the moment
    // one exists, every change here needs a bump and a migration.
    expect(RULESET_FINGERPRINT).toBe(
      "drop-scheme|lowercase-host|strip-leading-www|strip-root-dot|drop-userinfo|" +
        "drop-default-port|normalize-percent-escapes|plus-is-space-in-query|" +
        "strip-trailing-slash|preserve-path-case|drop-fragment-unless-sole-identity|" +
        "delete-tracking-params|sort-query-by-name-then-value|prefixes:utm_|" +
        "params:_hsenc,at_campaign,at_medium,cmp,fbclid,gclid,igshid,mc_cid,mc_eid,partner,ref,smid,source|" +
        "unreserved:^[A-Za-z0-9\\-._~]$",
    );
  });

  it("is actually DERIVED from the deny list, not a parallel constant", () => {
    // Rebuilt from the exported arrays, so a fingerprint hardcoded to a string
    // that no longer tracks the rules it describes fails here.
    //
    // The previous version of this test asserted only that a string
    // substitution produced a different string — true of any string at all, so
    // a fully hardcoded fingerprint passed the whole suite.
    expect(RULESET_FINGERPRINT).toContain(`prefixes:${TRACKING_PARAM_PREFIXES.join(",")}`);
    expect(RULESET_FINGERPRINT).toContain(`params:${[...TRACKING_PARAMS].sort().join(",")}`);
  });

  it("names every rule the canonicaliser applies", () => {
    // A rule added to the code but not to the fingerprint would change
    // behaviour without changing the fingerprint — the exact hole this guards.
    // Keep this list in step with `canonicalUrl`'s body.
    for (const rule of [
      "drop-scheme",
      "lowercase-host",
      "strip-leading-www",
      "drop-userinfo",
      "drop-default-port",
      "normalize-percent-escapes",
      "strip-trailing-slash",
      "preserve-path-case",
      "drop-fragment",
      "delete-tracking-params",
      "sort-query-by-name-then-value",
    ]) {
      expect(RULESET_FINGERPRINT).toContain(rule);
    }
  });

  it("includes every tracking parameter and prefix", () => {
    for (const p of TRACKING_PARAMS) expect(RULESET_FINGERPRINT).toContain(p);
    for (const p of TRACKING_PARAM_PREFIXES) expect(RULESET_FINGERPRINT).toContain(p);
  });

  it("covers the 14 names §6.1 lists", () => {
    // `utm_*` is the prefix; the other 13 are exact names.
    expect(TRACKING_PARAM_PREFIXES).toHaveLength(1);
    expect(TRACKING_PARAMS).toHaveLength(13);
  });
});

describe("rung 3 is versioned too", () => {
  it("pins the window at 500 characters, as §6.1 specifies", () => {
    expect(CONTENT_HASH_PREFIX_CHARS).toBe(500);
  });

  it("pins the rung-3 version", () => {
    // Rung 3 had no version at all, which was a real gap: changing the entity
    // table or the tag stripping changes every digest the function will ever
    // produce, invalidating every stored `content_hash` — with nothing failing
    // and no record of which ruleset produced which row.
    expect(CONTENT_HASH_VERSION).toBe(1);
  });

  it("pins the rung-3 fingerprint", () => {
    // Same contract as the URL fingerprint above, including the pre-M6
    // exemption: if this fails, ask whether every stored content_hash has just
    // been invalidated before updating it, and bump CONTENT_HASH_VERSION in
    // the same commit.
    //
    // The entries are key=VALUE, not just keys. Fingerprinting only the names
    // let a changed MAPPING — `nbsp` to a non-breaking space, or correcting
    // `prime` — pass this guard and the entity-free golden digest while
    // changing every digest the function produces.
    expect(CONTENT_HASH_FINGERPRINT).toBe(
      "prefix:500|nfc|strip-script-style|strip-comments|strip-declarations|" +
        "strip-tag-like-only|decode-entities|strip-c0-after-decode|collapse-whitespace|trim|" +
        "lowercase-title|nul-separator|sha256|" +
        "entities:AMP=&,Agrave=\u00C0,Auml=\u00C4,COPY=\u00A9,Ccedil=\u00C7," +
        'Eacute=\u00C9,Egrave=\u00C8,GT=>,LT=<,Ouml=\u00D6,Prime=\u2033,QUOT=",REG=\u00AE,' +
        "Uuml=\u00DC,agrave=\u00E0,amp=&,apos=',auml=\u00E4,bull=\u2022,ccedil=\u00E7," +
        "copy=\u00A9,deg=\u00B0,eacute=\u00E9,egrave=\u00E8,euro=\u20AC,gt=>,hellip=\u2026," +
        "ldquo=\u201C,lsquo=\u2018,lt=<,mdash=\u2014,middot=\u00B7,nbsp= ,ndash=\u2013," +
        'ouml=\u00F6,pound=\u00A3,prime=\u2032,quot=",rdquo=\u201D,reg=\u00AE,' +
        "rsquo=\u2019,szlig=\u00DF,trade=\u2122,uuml=\u00FC",
    );
  });

  it("names every step the hasher applies", () => {
    for (const step of [
      "nfc",
      "strip-script-style",
      "strip-comments",
      "strip-declarations",
      "strip-tag-like-only",
      "decode-entities",
      "strip-c0-after-decode",
      "collapse-whitespace",
      "lowercase-title",
      "nul-separator",
      "sha256",
    ]) {
      expect(CONTENT_HASH_FINGERPRINT).toContain(step);
    }
  });
});
