import type { Feed, SubscriptionWithUnread } from "@/lib/types";

/*
 * The per-feed hedge on Appendix G question 3, and the feed's guid-trust state.
 *
 * Q3 IS SETTLED: an edited article does NOT return to unread. It keeps its
 * `read_at` and gets a revision badge, following NewsBlur (§6.2). The reasoning
 * is in `lib/ingest/revise.ts` — the short version is that a CMS re-rendering
 * bodies on every deploy would otherwise make a feed permanently and falsely
 * unread, and an unread count that cannot be cleared is the failure §6.1 says
 * actually loses readers.
 *
 * But for changelogs, status pages and "live" posts the edit IS the news, so the
 * toggle exists. Per SUBSCRIPTION rather than per feed, because two readers can
 * want different answers about the same feed and a feed row is shared by
 * everyone.
 *
 * It renders as a receipt rather than a working control, like every other write
 * in phase 1: `updateSubscription` throws `NotImplementedInStaticPhase` naming
 * the endpoint it will use, and the prototype boards that state deliberately
 * (`ux-24`, `ux-44`). Showing a switch that silently does nothing would be
 * worse than showing what is not wired yet.
 */

/**
 * Which rung this feed's items are matched on, and why — §6.1's learned state.
 *
 * `guid_trust_override` is deliberately NOT shown. It exists on the row and in
 * `UpdateSubscriptionInput`, but not on the `Feed` domain type, so this
 * component cannot read it — and adding it would mean widening the type, the
 * twelve fixture feeds and the parity seam for a control M8 does not build.
 * The two states M8 is about, both learned rather than configured, are here.
 */
function trustLine(feed: Feed): { label: string; detail: string } {
  if (feed.guidUnstable) {
    return {
      label: "Matched by address",
      detail: feed.guidUnstableSince
        ? `This feed changed its ids on every build, so they stopped being trusted on ${feed.guidUnstableSince.slice(0, 10)}. That is permanent.`
        : "This feed changed its ids on every build, so they stopped being trusted. That is permanent.",
    };
  }
  if (feed.cleanPolls !== null && feed.cleanPolls < 3) {
    return {
      label: "Matched by address while it is new",
      detail: `Trusted slowly: ${feed.cleanPolls} of 3 checks have shown its ids holding still. Until then every item is matched on its address first, so nothing arrives twice.`,
    };
  }
  return {
    label: "Matched by the feed's own ids",
    detail: "Its ids have held still, so they are trusted. Addresses are still checked after them.",
  };
}

export function RevisionOverride({ sub }: { sub: SubscriptionWithUnread }) {
  const trust = trustLine(sub.feed);
  const on = sub.resurfaceOnRevision;

  return (
    <section className="gap-md grid">
      <h2>How this feed is matched</h2>

      <div className="gap-2xs border-rule bg-paper-hi px-lg py-md grid border">
        <p className="text-ink font-medium">{trust.label}</p>
        <p className="text-ink-2 text-sm">{trust.detail}</p>
      </div>

      <h2>When an article is edited</h2>

      <div className="gap-xs border-rule bg-paper-hi px-lg py-md grid border">
        <p className="text-ink font-medium">
          {on ? "Edited articles come back to unread" : "Edited articles stay read"}
        </p>
        <p className="text-ink-2 text-sm">
          {on
            ? "An edit returns this feed's articles to unread, and says when you had read it. Right for a changelog or a status page, where the edit is the news."
            : "An edit keeps your read mark and adds a “Revised” badge. A publisher fixing a typo does not put the article back in your unread count."}
        </p>
        <p className="text-muted text-sm">
          Nothing was sent: this control is not connected to PATCH /api/subscriptions/{sub.feedId}{" "}
          yet. The setting shown is the stored one.
        </p>
      </div>
    </section>
  );
}
