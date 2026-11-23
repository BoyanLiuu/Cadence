import "@testing-library/jest-dom/vitest";

/*
 * `.env` is loaded here, not only by Next and the Prisma CLI.
 *
 * Without it every database-backed suite skipped — the guards read
 * `process.env.DATABASE_URL` and vitest does not load dotfiles. 31 tests
 * reported as "skipped" while a working database sat beside them, which is a
 * worse failure than a red test: a skip looks like a deliberate choice.
 */
import "dotenv/config";

/*
 * Resolve `getViewer()` to the fixture reader.
 *
 * From M11 that function reads a Clerk session, and no suite has one — so
 * without this every database-backed test resolves to `anon`, is refused, and
 * reports an authorization failure that is really a missing request context.
 *
 * SET HERE rather than inferred inside `viewer.ts`, and the variable is named
 * for its purpose. The shortcut is `NODE_ENV !== "production"`, which is
 * ambient, true in staging, and one misconfigured deploy away from serving the
 * fixture reader's data to the public.
 */
process.env.CADENCE_TEST_VIEWER = "fixture";
