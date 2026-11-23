import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * What this suite is for: keeping a remote third-party script off the reader.
 *
 * `ClerkProvider` loads `clerk.browser.js` and `ui.browser.js` from the Clerk
 * instance's own origin. `clerk init` put the provider in the ROOT layout,
 * which wraps every route, and measured on the running server that made the
 * reader request EIGHT scripts from `*.clerk.accounts.dev` plus two calls to
 * Clerk's API — on the surface that renders titles, summaries and extracted
 * bodies fetched from arbitrary publishers.
 *
 * It bought nothing. The provider exists to serve Clerk's CLIENT components
 * and no reading surface renders one; `auth()` and `currentUser()` from
 * `@clerk/nextjs/server` work with no provider, which is how the session is
 * resolved. So the provider is scoped to `/sign-in` and `/sign-up`.
 *
 * This is mechanical because the regression is INVISIBLE. Re-running
 * `clerk init`, following any Clerk quickstart, or accepting a suggestion to
 * "wrap the app in ClerkProvider" puts it back, and nothing breaks: every page
 * still renders, every test still passes, and the only difference is eight
 * requests to someone else's origin on the page that can least afford them.
 * Nobody would notice without opening the network panel.
 *
 * It scans the WHOLE of `src`, not just the routes. The first version checked
 * `src/app` alone, which left the obvious vector wide open: `AppBar` lives in
 * `src/components` and renders on every reading surface, so a `<UserButton />`
 * added there — the natural way to show who is signed in — would have loaded
 * Clerk's bundle everywhere with all five tests still green. Scanning every
 * source directory also closes the wrapper-component hole, because a wrapper
 * has to import the client entry from somewhere, and that somewhere is now in
 * scope wherever it lives.
 */

const SRC_DIR = join(__dirname, "..");
const APP_DIR = __dirname;

/** The two routes that render Clerk's own components, and so need the provider. */
const CLERK_UI_ROUTES = ["sign-in", "sign-up"];

/**
 * Any CLIENT entry point of the SDK, matched as a module specifier so a
 * `require` or a dynamic `import()` counts too.
 *
 * `@clerk/nextjs/server` is the one path deliberately NOT matched: it is
 * server-only, ships nothing to the browser, and is what every reading surface
 * is expected to use. The negative lookahead is what draws that line — an
 * earlier version matched only the bare `@clerk/nextjs`, which let the
 * `/legacy` and `/experimental` client subpaths straight through.
 */
const CLIENT_IMPORT = /["']@clerk\/nextjs(?!\/server)(\/[^"']*)?["']/;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // `generated/` is Prisma's output: not ours to police, and megabytes.
      if (entry === "generated") continue;
      out.push(...filesUnder(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Necessary, not fussy, and the same reason `no-offset.test.ts` gives: the
 * prose above mentions both `@clerk/nextjs` and `ClerkProvider` by name while
 * explaining why they are absent. A guard that failed on its own documentation
 * would get the documentation deleted, which is the opposite of the point.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const isClerkUiRoute = (path: string) => {
  const rel = relative(APP_DIR, path);
  if (rel.startsWith("..")) return false;
  return CLERK_UI_ROUTES.some((route) => rel === route || rel.startsWith(`${route}/`));
};

describe("Clerk's client bundle is scoped to the sign-in and sign-up routes", () => {
  const all = filesUnder(SRC_DIR);
  const mustStayClean = all.filter((path) => !isClerkUiRoute(path));

  it("scans the files that could carry the regression, so no path change makes this vacuous", () => {
    // A green suite that checked nothing would be worse than no suite. Named
    // explicitly rather than counted, because the COUNT was what made the
    // first version look thorough while missing the one file that matters.
    const scanned = new Set(mustStayClean.map((path) => relative(SRC_DIR, path)));

    expect(scanned, "the root layout must be in scope").toContain("app/layout.tsx");
    expect(scanned, "the app bar renders on every reading surface").toContain(
      "components/app-bar.tsx",
    );
    expect(scanned, "the reader pane renders publisher text").toContain(
      "components/reader-pane/index.tsx",
    );
    expect(all.filter(isClerkUiRoute).length).toBeGreaterThan(1);
  });

  it.each(CLERK_UI_ROUTES)("/%s has its own layout holding the provider", (route) => {
    /*
     * The other half of the rule. Without these, scoping the provider out of
     * the root layout would simply BREAK sign-in rather than relocate it — and
     * the fix someone reaches for under that pressure is to put it back.
     *
     * Comments stripped first: `sign-in/layout.tsx` explains the arrangement
     * in prose that names `ClerkProvider`, so matching raw text would pass for
     * a file that had kept the explanation and lost the provider.
     */
    const source = withoutComments(readFileSync(join(APP_DIR, route, "layout.tsx"), "utf8"));
    expect(source).toMatch(/<ClerkProvider>/);
    expect(source).toMatch(CLIENT_IMPORT);
  });

  it("nothing else imports a client entry point", () => {
    const offenders = mustStayClean
      .filter((path) => CLIENT_IMPORT.test(withoutComments(readFileSync(path, "utf8"))))
      .map((path) => relative(SRC_DIR, path));

    expect(
      offenders,
      "these import a CLIENT entry of @clerk/nextjs, which pulls Clerk's " +
        "remote scripts onto pages that render publisher-supplied text. Use " +
        "@clerk/nextjs/server, or move the component under app/sign-in/ or " +
        "app/sign-up/",
    ).toEqual([]);
  });

  it("the root layout renders no provider", () => {
    // Checked by name as well as by import, so a local wrapper that re-exports
    // the provider under another name still has to pass the import scan above.
    expect(withoutComments(readFileSync(join(APP_DIR, "layout.tsx"), "utf8"))).not.toMatch(
      /ClerkProvider/,
    );
  });
});
