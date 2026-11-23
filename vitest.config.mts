import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    /*
     * THE CONNECTION CEILING, and it is arithmetic rather than caution.
     *
     * Every test file is its own process with its own Prisma pool, and that
     * pool holds up to 3 connections (`poolMax()` in `src/lib/db/client.ts`),
     * while Supabase's session pooler allows 15 clients. Unbounded, 54 files
     * ask for up to 162 — so the suites passed by luck for weeks and then
     * failed in batches with `EMAXCONNSESSION: max clients reached in session
     * mode`, which reads like a connection leak and is not one. 4 x 3 = 12
     * fits with headroom.
     *
     * HERE AND NOT IN `test:db`, which is where it first went and where review
     * found it does not hold: `CADENCE_DB_WRITE_TESTS` can be set in `.env`
     * (and `.env.example` invites exactly that), which `vitest.setup.ts` loads
     * for EVERY run — so `pnpm check` would run all fifteen write suites
     * uncapped and hit the same wall. A limit that depends on which script you
     * typed is not a limit.
     *
     * Raising it means lowering `DATABASE_POOL_MAX` to match, and that has its
     * own floor: at 1, `lease-claim.test.ts`'s `SKIP LOCKED` case cannot work,
     * because proving two transactions do not block each other needs two
     * connections. Measured — it fails there.
     */
    maxWorkers: 4,
  },
});
