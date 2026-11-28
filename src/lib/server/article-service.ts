import * as db from "./article-service.db";
import * as fixtures from "./article-service.fixtures";

/*
 * The data access boundary (ARCHITECTURE Appendix C) — the chooser.
 *
 * Appendix C's phase-2 check is a SEAM TEST: "swap the service implementation
 * back to fixtures and the UI must be identical." That is only possible while
 * both implementations exist, so this file picks one and nothing else in the
 * codebase knows which it got.
 *
 * The default is Postgres when `DATABASE_URL` is set and fixtures when it is
 * not, which keeps two properties that are both worth having:
 *
 *  - A clone with no database still runs every screen and every test. The
 *    fixture corpus is the test corpus (Appendix C rule 5), and 561 of the
 *    tests predate the schema.
 *  - `CADENCE_DATA_SOURCE=fixtures` forces the comparison at will, which is
 *    what `service-parity.test.ts` uses.
 *
 * This is not a permanent hedge. It is the mechanism that makes "the UI did
 * not change" checkable, and it costs one module of indirection.
 */

type Implementation = typeof fixtures;

function chooseImplementation(): Implementation {
  const forced = process.env.CADENCE_DATA_SOURCE;
  if (forced === "fixtures") return fixtures;
  if (forced === "db") return db;
  return process.env.DATABASE_URL ? db : fixtures;
}

const impl = chooseImplementation();

/** Which implementation is live. Reported on the health screen, not inferred. */
export const dataSource: "db" | "fixtures" = impl === db ? "db" : "fixtures";

export const listSubscriptions: Implementation["listSubscriptions"] = (...args) =>
  impl.listSubscriptions(...args);
export const listFolders: Implementation["listFolders"] = (...args) => impl.listFolders(...args);
/*
 * The LIST's cheap read of the subscribed feeds. Separate from
 * `listSubscriptions` because that one derives unread counts and today's
 * counters — two round trips the list pane waited on and never read. See
 * `ListFeed` in `types.ts`.
 */
export const listFeedLabels: Implementation["listFeedLabels"] = (...args) =>
  impl.listFeedLabels(...args);
export const listTicks: Implementation["listTicks"] = (...args) => impl.listTicks(...args);
export const listArticles: Implementation["listArticles"] = (...args) => impl.listArticles(...args);
export const getArticle: Implementation["getArticle"] = (...args) => impl.getArticle(...args);
export const countUnread: Implementation["countUnread"] = (...args) => impl.countUnread(...args);
export const getFeedHealth: Implementation["getFeedHealth"] = (...args) =>
  impl.getFeedHealth(...args);
