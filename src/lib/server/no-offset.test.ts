import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * What this suite is for: the regression that makes month-three queries slow.
 *
 * `OFFSET 5000` makes Postgres walk and discard five thousand rows to return
 * fifty. It is indistinguishable from keyset paging on a fixture of 124
 * articles and on a database of a thousand, and then it is the reason every
 * list query times out — by which point the pagination is wired into every
 * screen and the cursor shape is in people's bookmarks.
 *
 * ARCHITECTURE N6 and §3 both say never. This is the only mechanical way to
 * keep that true, because the correct version is not visibly different from
 * the wrong one until it is too late to change cheaply.
 */

const SERVER_DIR = join(__dirname);
const DB_DIR = join(__dirname, "../db");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...filesUnder(path));
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

describe("no OFFSET anywhere in the data layer", () => {
  const files = [...filesUnder(SERVER_DIR), ...filesUnder(DB_DIR)];

  it("finds files to check, so a path change cannot make this vacuous", () => {
    // A green suite that checked nothing would be worse than no suite.
    expect(files.length).toBeGreaterThan(2);
  });

  /**
   * Source with comments removed.
   *
   * Necessary, not fussy: the first run of this check failed on the COMMENTS
   * in `article-service.ts` that explain why offsets are banned. A guard that
   * forbids documenting the rule it enforces would get the documentation
   * deleted, which is the opposite of the point.
   *
   * String literals are deliberately kept — that is where real SQL lives.
   */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it.each(files.map((f) => [f.replace(`${process.cwd()}/`, ""), f]))(
    "%s uses no OFFSET",
    (_label, path) => {
      const source = withoutComments(readFileSync(path, "utf8"));
      // Word-boundary matched and case-insensitive, so `offset`, `OFFSET` and
      // a newline-prefixed SQL keyword are all caught, while `offsetWidth` and
      // `timezoneOffset` are not. A SQL offset is always a standalone word.
      const hits = source.match(/\boffset\b(?!\w)/gi) ?? [];
      expect(hits, `found ${hits.length} use(s) of OFFSET in ${path}`).toEqual([]);
    },
  );

  it("would still catch a real OFFSET in a query string", () => {
    // Proves the comment stripping did not defeat the check it protects.
    const sample = `const sql = "SELECT * FROM articles ORDER BY id LIMIT 50 OFFSET 500";`;
    expect(withoutComments(sample).match(/\boffset\b(?!\w)/gi)).toHaveLength(1);
  });

  it("ignores the word inside a comment", () => {
    const sample = `// never use OFFSET here\n/* OFFSET is banned */\nconst a = 1;`;
    expect(withoutComments(sample).match(/\boffset\b(?!\w)/gi)).toBeNull();
  });

  it("does not flag property names that merely contain it", () => {
    const sample = `const h = el.offsetHeight + date.getTimezoneOffset();`;
    expect(withoutComments(sample).match(/\boffset\b(?!\w)/gi)).toBeNull();
  });

  it("still uses a keyset cursor in the article service", () => {
    // The mirror of the rule: proving OFFSET is absent is only half of it, and
    // a service that paginated by nothing at all would pass the check above.
    const source = readFileSync(join(SERVER_DIR, "article-service.ts"), "utf8");
    expect(source).toContain("cursor.publishedAt");
    expect(source).toContain("cursor.id");
  });
});
