import { prisma } from "@/lib/db/client";

import type { LadderCounters } from "./dedupe";

/*
 * One row per poll attempt — §6.2 calls it "the only evidence dedup works".
 *
 * Pulled forward from M9, which owns the sweep that will call it on every tick.
 * It is here because M8's guid-instability detector needs THREE CONSECUTIVE
 * POLLS of counters, and those polls are three separate invocations with
 * nothing carried between them but the database. Without this table the
 * detector has no history to read and M8 cannot be finished, so the
 * alternative was a second temporary home for the same numbers.
 *
 * The counters are also the whole of the health screen: a 304 ratio, a collapse
 * rate by rung, a failure history. A feed that is failing says why and when it
 * will retry (§8), and this is where that comes from.
 */

/** What the HTTP half of a poll did. M9 fills these in; M8 passes nulls. */
export type PollTransport = {
  /** Null for a poll that never got a response — a timeout, a DNS failure. */
  statusCode: number | null;
  durationMs: number;
  bytes: number | null;
  /** A stable short code, not a message. `ETIMEDOUT`, `28P01`, `not_a_feed`. */
  errorCode?: string | null;
  /** Free text for the one case a code cannot carry. Rare by design. */
  note?: string | null;
};

/**
 * Records one poll.
 *
 * Must run BEFORE `recordTrust`, because the detector reads the three most
 * recent rows and the poll just finished is one of them. Called even for a
 * poll that fetched nothing — a `304`, a timeout and a parse failure are all
 * facts the health screen needs, and a table that only records successes
 * cannot show a feed failing.
 */
export async function recordPoll(
  feedId: bigint,
  counters: LadderCounters,
  transport: PollTransport,
): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO cadence.fetch_log
      (feed_id, at, status_code, duration_ms, bytes,
       items_seen, items_new,
       merged_by_guid, merged_by_url, merged_by_content,
       guid_agreed, guid_churned,
       revised, error_code, note)
    VALUES
      (${feedId}, now(), ${transport.statusCode}, ${transport.durationMs}, ${transport.bytes},
       ${counters.itemsSeen}, ${counters.itemsNew},
       ${counters.mergedByGuid}, ${counters.mergedByUrl}, ${counters.mergedByContent},
       ${counters.guidAgreed}, ${counters.guidChurned},
       ${counters.revised}, ${transport.errorCode ?? null}, ${noteFor(counters, transport)})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * The note, which carries what no column does.
 *
 * Only the insert cap for now, and it earns the space: N7's cap silently
 * truncating a poll is the one outcome an operator must not have to infer from
 * a suspiciously round `items_new`. An explicit caller-supplied note wins.
 */
function noteFor(counters: LadderCounters, transport: PollTransport): string | null {
  if (transport.note !== undefined && transport.note !== null) return transport.note;
  if (counters.capHit) {
    return `insert cap reached; ${counters.itemsCapped} new articles refused`;
  }
  return null;
}
