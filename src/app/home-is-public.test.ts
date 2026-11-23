import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * What this suite is for: `/` renders for a visitor with no session.
 *
 * §2 says there is no public reading surface — every article list is somebody's
 * subscription list. The home page is the one exception the product has, and it
 * is only safe because it reads NOTHING: no session, no database, no fixtures.
 * Its figure is a drawing of the corpus's syndicated story, with every string a
 * literal.
 *
 * The way that breaks is small and reasonable-looking. "The home page should
 * show how many feeds Cadence is polling" or "let's show a real recent
 * headline" is one import away, and the moment the page can reach data access
 * it needs a viewer — which it cannot have, because nobody is signed in. What
 * happens then depends on which implementation answers: the fixtures path
 * renders one reader's data to the public, and the database path throws
 * `NotAllowedError` and turns the front page into a 500.
 *
 * SO IT FOLLOWS THE IMPORT GRAPH, rather than checking the page's own source.
 * The first version did the latter and review found both holes it leaves: it
 * listed two filenames by hand, so a new `home-stats.tsx` importing
 * `article-service` kept every assertion green, and it forbade `@/lib/server`
 * and `@/lib/db` by name while `@/lib/ingest` and `@/lib/schedule` both import
 * `@/lib/db/client` themselves — which is to say the suite's own named example,
 * "how many feeds are we polling", passed it. A transitive closure cannot be
 * fooled by either, because it asks what the page can REACH rather than what it
 * mentions.
 */

const SRC = resolve(__dirname, "..");

/** The page under the rule. Everything it reaches is in scope. */
const ENTRY = join(__dirname, "page.tsx");

/**
 * Modules that can answer a question about a reader's data, by the paths that
 * actually open a connection or hold the corpus.
 *
 * Matched against RESOLVED paths, so a module that reaches one of these
 * indirectly is caught by the walk rather than by this list.
 */
const DATA_MODULES = [
  join(SRC, "lib/db"),
  join(SRC, "lib/server"),
  join(SRC, "lib/fixtures"),
  join(SRC, "generated/prisma"),
];

/** Bare specifiers that mean a database no matter where they are imported. */
const DATA_PACKAGES = /^(@prisma\/|prisma$|pg$)/;

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every module specifier in a file: `import`, `export … from`, `import()`. */
function specifiers(source: string): string[] {
  return [
    ...withoutComments(source).matchAll(/from\s*["']([^"']+)["']|import\(["']([^"']+)["']\)/g),
  ]
    .map((m) => m[1] ?? m[2])
    .filter((s): s is string => s !== undefined);
}

/** `@/x` and `./x` to a file on disk; `null` for anything in node_modules. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(fromFile, "..", specifier)
      : null;
  if (base === null) return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // A directory that exists but is not a file: keep trying.
      }
    }
  }
  // Unresolvable means a path alias or extension this walk does not know, and
  // treating it as "nothing to see" is how a guard goes quiet. Reported.
  return base;
}

/** Everything `ENTRY` can reach, with the first path that reaches each file. */
function importClosure(entry: string): { files: Map<string, string[]>; packages: Set<string> } {
  const files = new Map<string, string[]>([[entry, [entry]]]);
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const trail = files.get(file)!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // Recorded in `files` so an unresolvable import still shows up.
    }

    for (const specifier of specifiers(source)) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved === null) {
        packages.add(specifier);
        continue;
      }
      if (files.has(resolved)) continue;
      files.set(resolved, [...trail, resolved]);
      queue.push(resolved);
    }
  }
  return { files, packages };
}

const rel = (path: string) => path.replace(`${SRC}/`, "");

describe("the home page reads nothing", () => {
  const { files, packages } = importClosure(ENTRY);

  it("walks the page's imports, so the rule cannot pass by reading nothing", () => {
    // `page.tsx` reaches `home-scene.tsx`; if the walk ever stops finding even
    // that, every assertion below is vacuous.
    expect([...files.keys()].map(rel)).toContain("app/home-scene.tsx");
  });

  it("reaches no data access, however indirectly", () => {
    const offenders = [...files.entries()]
      .filter(([file]) => DATA_MODULES.some((dir) => file.startsWith(`${dir}/`) || file === dir))
      .map(([, trail]) => trail.map(rel).join(" -> "));

    expect(
      offenders,
      "the home page can reach data access by these paths. It renders for a " +
        "visitor with no session, so there is no viewer to scope a read to: " +
        "the fixtures path would publish one reader's data and the database " +
        "path would throw. Keep the figure's strings literal.",
    ).toEqual([]);
  });

  it("imports no database package", () => {
    const offenders = [...packages].filter((name) => DATA_PACKAGES.test(name));
    expect(offenders, "reached from the home page").toEqual([]);
  });

  it("every import it reaches actually resolved", () => {
    /*
     * A specifier this walk cannot resolve would be followed no further, and
     * an unfollowed import is exactly where a data read would hide. Better to
     * fail here and teach the resolver than to pass by not looking.
     */
    const missing = [...files.keys()].filter((file) => !existsSync(file)).map(rel);
    expect(missing, "unresolvable imports reached from the home page").toEqual([]);
  });

  it("the reader, which DOES read, is caught by the same walk", () => {
    /*
     * The control. A closure that silently found nothing, or a `DATA_MODULES`
     * list that matched nothing, would pass every assertion above for the
     * wrong reason — so the nearest page that legitimately reads is run
     * through the same code and must come back dirty.
     */
    const reader = importClosure(join(__dirname, "(reader)", "reader", "page.tsx"));
    const reached = [...reader.files.keys()].filter((file) =>
      DATA_MODULES.some((dir) => file.startsWith(`${dir}/`)),
    );
    expect(reached.length, "the reader should reach data access").toBeGreaterThan(0);
  });
});
