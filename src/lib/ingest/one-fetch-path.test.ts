import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * What this suite is for: there is ONE way out to the internet.
 *
 * Every outbound request this server makes goes through `fetchFeed`, which
 * defaults to `guardUrl` and re-validates each redirect hop. That matters
 * because the addresses are READER-SUPPLIED — `subscribe` accepts any `http(s)`
 * URL — so without the guard, `http://169.254.169.254/latest/meta-data/` is a
 * feed this server will fetch from inside its own network and render to whoever
 * asked for it (§6.3).
 *
 * THE CLAIM EXISTED AND WAS NOT CHECKED. `fetch.ts` asserts in a comment that
 * "nothing in `src/app` or `src/lib/schedule` passes this" — about the
 * loopback-permitting test validator — and that was true by inspection on the
 * day it was written. M12 adds the first new outbound caller in the project
 * (discovery, which fetches candidate feeds), which is exactly when a comment
 * stops being load-bearing enough.
 *
 * So: a direct `fetch(` to anywhere server-side is a failure here, and so is
 * any production use of the test validator. The one sanctioned call site is
 * inside `fetch.ts` itself, after the guard has answered.
 */

const SRC = join(__dirname, "..", "..");

/** The module that owns the sanctioned call, and the only exemption. */
const THE_FETCH_MODULE = join(SRC, "lib/ingest/fetch.ts");

/**
 * Client components may call `fetch` freely: it runs in the reader's browser,
 * to our own origin, with no server network to reach. `mark-read-on-scroll`
 * does exactly that.
 */
const isClientComponent = (source: string) =>
  // `codeOnly` FIRST. Against raw source a comment line quoting "use client" —
  // this project writes comments that quote directives — exempted a whole
  // server module from the one guard standing between a reader-supplied
  // address and an unguarded fetch.
  /^\s*["']use client["']/m.test(codeOnly(source));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated") continue; // Prisma's output, not ours to police.
      out.push(...filesUnder(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Source with comments removed, by a scanner rather than two regexes.
 *
 * THE REGEX VERSION COULD EAT CODE, which this suite cannot afford: the scans
 * below look for `fetch(` in the stripped text, so a file whose body vanished
 * would pass them by containing nothing. It happened on `fetch.ts` the first
 * time this was written — a `/*` or closing sequence inside a string literal
 * makes the block-comment regex lose its place and swallow everything to the
 * next one.
 *
 * So this tracks whether it is inside a string, a template or a comment, which
 * is the one thing a regex cannot do. Twenty lines, and it cannot silently
 * delete the thing it was asked to read.
 */
function codeOnly(source: string): string {
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";

  let out = "";
  let mode: Mode = "code";
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const two = source.slice(i, i + 2);

    if (mode === "code") {
      if (two === "//") {
        mode = "line";
        i += 2;
      } else if (two === "/*") {
        mode = "block";
        i += 2;
      } else {
        if (ch === "'" || ch === '"' || ch === "`") mode = ch;
        out += ch;
        i += 1;
      }
    } else if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
      i += 1;
    } else if (mode === "block") {
      if (two === "*/") {
        mode = "code";
        i += 2;
      } else {
        i += 1;
      }
    } else if (ch === "\\") {
      // Inside a string, a backslash escapes whatever follows — including the
      // quote that would otherwise end it.
      out += source.slice(i, i + 2);
      i += 2;
    } else {
      if (ch === mode) mode = "code";
      out += ch;
      i += 1;
    }
  }
  return out;
}

const rel = (path: string) => relative(SRC, path);

describe("one way out to the internet", () => {
  const files = filesUnder(SRC);

  it("finds the modules that could reach the network", () => {
    // A green suite that scanned nothing would be worse than no suite, and
    // naming files rather than counting them is what caught a wrong path the
    // last time this pattern was used.
    const scanned = new Set(files.map(rel));
    expect(scanned).toContain("lib/ingest/fetch.ts");
    expect(scanned).toContain("lib/schedule/sweep.ts");
    expect(scanned).toContain("lib/server/mutations.ts");
  });

  it("no server-side module calls fetch() directly", () => {
    const offenders = files
      .filter((path) => path !== THE_FETCH_MODULE)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        if (isClientComponent(source)) return false;
        // `\bfetch(` and not `.fetch(`: `fetchFeed(` must not match, nor a
        // property called `fetch`.
        return /(?<![.\w])fetch\s*\(/.test(codeOnly(source));
      })
      .map(rel);

    expect(
      offenders,
      "these reach the network without the SSRF guard. Addresses here are " +
        "reader-supplied, so an unguarded fetch will dial a link-local or " +
        "private address from inside this server. Use `fetchFeed`, which " +
        "validates every hop",
    ).toEqual([]);
  });

  it("nothing in production uses the loopback-permitting test validator", () => {
    /*
     * `fetchHttpForTest` replaces the address check with one that allows
     * loopback, so a fixture server can be exercised. Reaching for it from
     * production code would disable the guard at the one call site that has it
     * — and it would look like a deliberate, named choice.
     */
    const offenders = files
      .filter((path) => path !== THE_FETCH_MODULE)
      .filter((path) => /fetchHttpForTest/.test(codeOnly(readFileSync(path, "utf8"))))
      .map(rel);

    expect(offenders, "the test-only validator must not be reachable from production").toEqual([]);
  });

  it("the sanctioned call site still validates before it dials", () => {
    /*
     * The control. The two assertions above would pass if `fetch.ts` stopped
     * guarding altogether — they only police everyone else. This checks the one
     * exemption still earns it: the call reads `guard.url`, which only exists
     * after the validator has answered, rather than the caller's own string.
     *
     * RAW SOURCE, not stripped. Writing this found that `withoutComments` can
     * eat code in this file — a `/*` or `*​/` sequence inside a string literal
     * makes the block-comment regex swallow everything to the next one. A
     * false positive from a comment that happens to quote this line is the
     * lesser risk.
     */
    const raw = readFileSync(THE_FETCH_MODULE, "utf8");

    expect(raw).toMatch(/await fetch\(\s*guard\.url/);
    expect(raw).toMatch(/validate\s*:/);
  });

  it("the stripper keeps code that LOOKS like a comment boundary", () => {
    /*
     * Directly, because the scans above are only as good as this. The regex
     * version this replaced lost its place on a `/*` inside a string literal
     * and swallowed the rest of the file — which would have made every scan
     * pass by reading nothing.
     */
    const tricky = [
      'const a = "/*";',
      "const b = `not /* a comment`;",
      "const c = '// also not';",
      "/* a real comment with fetch( in it */",
      "await fetch(guard.url);",
    ].join("\n");

    const code = codeOnly(tricky);

    expect(code).toContain("await fetch(guard.url);");
    expect(code).toContain('const a = "/*";');
    // And the real comment is gone, so a mention of `fetch(` in prose cannot
    // be reported as a call site.
    expect(code).not.toContain("a real comment");
  });
});
