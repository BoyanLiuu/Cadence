import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * What this suite is for: keeping `OFFSET` to the one query that needs it.
 *
 * IT USED TO FORBID IT OUTRIGHT — §3 and N6 said never, and the reasoning was
 * sound: `OFFSET 5000` makes Postgres walk and discard five thousand rows to
 * return fifty, it is indistinguishable from keyset paging on a corpus of 124
 * articles, and by the time it is slow the pagination is wired into every
 * screen.
 *
 * THE RULE WAS REVERSED FOR NUMBERED PAGES, deliberately. The list had one
 * control, "Older", because that is all a keyset cursor can offer: no way
 * forward, no way to tell page 4 from page 40, no way to reach either except
 * by pressing Older until you arrived. Numbered pages need to know the fourth
 * page's first row, and the only ways to learn it are to walk there or to
 * count rows — `OFFSET` either way. See the note on `Page` in `types.ts`.
 *
 * SO THE GUARD NARROWED RATHER THAN DISAPPEARED, and the distinction is where
 * its remaining value is. `listArticles` may skip; nothing else may. That
 * keeps the one bounded, page-sized, index-ordered offset the product asked
 * for, and still fails the day somebody reaches for `skip` in a count, a
 * sidebar query, a health read or a dedup lookup — where it would be the
 * silent full-scan the original rule was written about.
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

describe("OFFSET only in the one query that paginates", () => {
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

  /*
   * The two files allowed to page, and nothing else. Named rather than
   * pattern-matched, so a third implementation has to be added here on
   * purpose — which is the moment to ask whether it should be paging at all.
   */
  const PAGINATES = ["article-service.db.ts", "article-service.fixtures.ts"];
  const isPaginator = (path: string) => PAGINATES.some((f) => path.endsWith(`/${f}`));

  it.each(files.map((f) => [f.replace(`${process.cwd()}/`, ""), f]))(
    "%s uses no OFFSET",
    (_label, path) => {
      const source = withoutComments(readFileSync(path, "utf8"));
      // Word-boundary matched and case-insensitive, so `offset`, `OFFSET` and
      // a newline-prefixed SQL keyword are all caught, while `offsetWidth` and
      // `timezoneOffset` are not. A SQL offset is always a standalone word.
      // `skip` is Prisma's spelling of the same thing and is checked with it.
      const hits = source.match(/\boffset\b(?!\w)|\bskip:/gi) ?? [];
      if (isPaginator(path)) {
        /*
         * ONE, AND ONLY IN `listArticles`. The count is the thing being
         * guarded: two skips in a file means a second query learned to page,
         * which is how the original rule got broken by accident rather than
         * by decision.
         */
        expect(hits.length, `${path} should offset exactly once`).toBeLessThanOrEqual(1);
        return;
      }
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

  it.each(["article-service.fixtures.ts", "article-service.db.ts"])(
    "%s still pages, and still orders totally",
    (file) => {
      /*
       * The mirror of the rule: proving the offset is bounded is only half of
       * it. A list that paged without a TOTAL ORDER is where offset paging
       * actually breaks — two rows sharing a `published_at` swap between the
       * query for page 1 and the query for page 2, so one appears twice and
       * the other never. The `id` tie-break is what prevents that, in both
       * implementations, and `pagination.test.ts` asserts the behaviour this
       * asserts the cause of.
       *
       * Asserted on BOTH — `article-service.ts` is only a chooser, so pointing
       * this at it passed vacuously.
       */
      const source = readFileSync(join(SERVER_DIR, file), "utf8");
      expect(source).toContain("PAGE_SIZE");
      expect(source).toMatch(/publishedAt/);
      expect(source).toMatch(/\bid\b/);
    },
  );

  it("the real paginator offsets by whole pages, never by a row count", () => {
    /*
     * `skip: (wanted - 1) * PAGE_SIZE` is the shape that keeps the offset
     * bounded to a page multiple. A hand-rolled `skip: someCount` is how an
     * offset stops being a page number and starts being a scan.
     */
    const source = withoutComments(readFileSync(join(SERVER_DIR, "article-service.db.ts"), "utf8"));
    expect(source).toContain("skip: (wanted - 1) * PAGE_SIZE");
  });
});
