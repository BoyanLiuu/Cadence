/*
 * Which database tests may run, and why that is not simply "all of them".
 *
 * The Supabase project is SHARED with the workspace's other apps. Cadence owns
 * the `cadence` schema and nothing else, but the constraint probes genuinely
 * WRITE: they create feeds, articles and users to watch the indexes refuse
 * them, and an interrupted run leaves those rows behind.
 *
 * So the split is by what a suite does, not by whether a database exists:
 *
 *   READ-ONLY suites run whenever `DATABASE_URL` is set. The parity seam, the
 *   catalogue checks and the index-definition assertions are all reads, and
 *   they are the ones worth having in `pnpm check`.
 *
 *   WRITING suites need `CADENCE_DB_WRITE_TESTS=1`, which `pnpm test:db` sets.
 *   Opt-in, because `pnpm check` should never mutate a shared project — and
 *   because a test that silently writes to something shared is how a
 *   neighbouring app's afternoon gets ruined.
 */

/** A database is configured, so read-only suites can run. */
export const CAN_READ_DB = Boolean(process.env.DATABASE_URL);

/**
 * Writing to the database has been explicitly permitted.
 *
 * Deliberately not inferred from anything. There is no way to tell a scratch
 * database from a shared one by looking at the URL, so it is asked for.
 */
export const CAN_WRITE_DB = CAN_READ_DB && process.env.CADENCE_DB_WRITE_TESTS === "1";
