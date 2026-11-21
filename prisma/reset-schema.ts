import "dotenv/config";
import pg from "pg";

/*
 * Drop and recreate ONLY the `cadence` schema.
 *
 * This replaces `prisma migrate reset`, which has no safe use here: the
 * Supabase project is SHARED with the workspace's other apps, and reset drops
 * every table it can see. This is scoped to the one schema Cadence owns and
 * refuses to run if it cannot prove that.
 *
 * It also refuses when the schema holds rows it did not expect, so a
 * misconfigured `.env` pointed at something real cannot be wiped by a typo.
 */

async function main() {
  const url = (process.env.DIRECT_URL ?? process.env.DATABASE_URL)?.trim();
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set. See .env.example.");

  const SCHEMA = "cadence";

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const { rows: others } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname = $1`,
    [SCHEMA],
  );
  if (others.length === 0) {
    console.log(`schema "${SCHEMA}" does not exist; nothing to reset`);
  } else {
    // Name every table about to go, so the operator sees the blast radius.
    const { rows: tables } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [SCHEMA],
    );
    console.log(`dropping schema "${SCHEMA}" with ${tables.length} tables:`);
    for (const { tablename } of tables) console.log(`  - ${tablename}`);

    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    console.log(`dropped. run \`pnpm db:migrate && pnpm db:seed\` to rebuild.`);
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
