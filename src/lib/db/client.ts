import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/*
 * The one Prisma client.
 *
 * Three things here are not boilerplate:
 *
 * 1. THE URL COMES FROM A DRIVER ADAPTER, not from the schema. Prisma 7 rejects
 *    `url` in a `datasource` block as a hard validation error; the migrate URL
 *    lives in `prisma.config.ts` and the runtime URL here. They are different
 *    connections on purpose — `prisma migrate` cannot run over transaction-mode
 *    pooling, so it uses the session pooler while the app uses the transaction
 *    pooler.
 *
 * 2. THE POOL BUDGET IS PER PROCESS, AND THERE IS MORE THAN ONE PROCESS. Next
 *    runs several render workers, each opening its own pool, so the real
 *    ceiling is `workers x max` rather than `max`. §6.4's sweep is the load
 *    that finds this: 25 feeds claimed per tick with HTTP parallel at 6.
 *
 * 3. IT IS CACHED ACROSS HOT RELOADS. Without the global, `next dev` leaks a
 *    pool per edit and exhausts the pooler in a few minutes of work.
 *
 * 4. IT IS BUILT LAZILY, ON FIRST QUERY. Constructing it at module scope meant
 *    merely IMPORTING this file threw when `DATABASE_URL` was unset — which
 *    broke the fixture mode and three test suites that have no database and
 *    are not supposed to need one. A module that is imported must not demand
 *    configuration it may never use.
 */

const connectionString = process.env.DATABASE_URL;

/**
 * The pool size, or 3 for anything that is not a usable positive number.
 *
 * Exported so `client-config.test.ts` can test THIS function rather than a
 * copy of it. The copy was linked to the original by an exact source-substring
 * match, which prettier rewrapping or a rename would have broken silently.
 */
export function poolMax(): number {
  const parsed = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

function createClient() {
  if (!connectionString) {
    // A clear failure at the first query beats `undefined` reaching the driver
    // and surfacing as an unrelated connection error.
    throw new Error(
      "DATABASE_URL is not set. It belongs in `.env`, NOT `.env.local` — the " +
        "Prisma CLI does not read `.env.local`, so splitting them yields a " +
        "working app and a failing migration.",
    );
  }

  const adapter = new PrismaPg({
    connectionString,
    // Default 3. Measured against Supabase's session pooler, 6 per process
    // still exhausted it and 2 did not.
    //
    // `??` alone is not enough: an empty or unparseable value is a STRING, so
    // it survives the nullish check and then coerces to 0 — a pool that can
    // never hand out a connection.
    max: poolMax(),
  });

  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { cadencePrisma?: PrismaClient };

function getClient(): PrismaClient {
  if (!globalForPrisma.cadencePrisma) {
    const client = createClient();
    // Cached in production too: a serverless invocation reuses the module, and
    // a fresh pool per request is what exhausts the pooler during a sweep.
    globalForPrisma.cadencePrisma = client;
  }
  return globalForPrisma.cadencePrisma;
}

/**
 * The client, resolved on first property access.
 *
 * A Proxy rather than a function so every call site reads `prisma.article`
 * exactly as it would with a real client — the laziness is invisible, which
 * is what stops someone "simplifying" it back into an eager construction.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getClient() as object, property, receiver);
  },
}) as PrismaClient;
