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
