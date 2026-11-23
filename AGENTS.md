## Running the database suites

`pnpm test:db` caps vitest at **4 workers**, and the cap is load-bearing rather
than cautious. Every test file is its own process with its own Prisma pool, and
that pool holds up to **3** connections (`poolMax()` in `src/lib/db/client.ts`),
while Supabase's session pooler allows **15 clients**. Unbounded, 54 files ask
for up to 162 — so the suite passed by luck for weeks and then failed in
batches with `EMAXCONNSESSION: max clients reached in session mode`, which reads
like a leak and is not one. 4 × 3 = 12 fits with headroom.

Two things follow:

- **Raising the cap means lowering `DATABASE_POOL_MAX` to match**, and that has
  its own floor: at 1, `lease-claim.test.ts`'s `SKIP LOCKED` case cannot work,
  because proving two transactions do not block each other needs two
  connections. A test that waits on the pool instead of the lock passes for the
  wrong reason or fails for one.
- **Never kill a DB suite mid-run.** Each file cleans up its own feeds in
  `afterAll`, so an interrupted run leaves them behind — and `parse-twice.test`
  then fails with `expected 0 to be greater than 0`, because the corpus it
  means to insert is already there and rung 2 matches all of it. The fix is
  `pnpm db:seed`, which wipes and rebuilds.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
