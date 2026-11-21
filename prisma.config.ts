import { defineConfig } from "prisma/config";
import "dotenv/config";

/*
 * Prisma 7 rejects connection URLs in `schema.prisma` — `url` and `directUrl`
 * in a `datasource` block are hard validation errors, and `directUrl` was
 * removed outright. So the MIGRATE url lives here and the RUNTIME url goes to
 * the PrismaPg driver adapter in `src/lib/db/client.ts`.
 *
 * They are different connections on purpose: `prisma migrate` cannot run over
 * transaction-mode pooling, so it needs the session pooler (5432) while the app
 * uses the transaction pooler (6543).
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
