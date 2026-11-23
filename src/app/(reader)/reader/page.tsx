import { ReaderView, type ReaderSearchParams } from "../reader-view";

/**
 * `GET /reader` — the three-pane reader, scoped to every subscribed feed (§3).
 *
 * It lived at `/` until M11, when `/` became the public home page. The two
 * cannot share a route: §2 says there is no public reading surface, so `/` has
 * to render for a visitor with no session, and this must not.
 */
export default async function ReaderPage({
  searchParams,
}: {
  searchParams: Promise<ReaderSearchParams>;
}) {
  return <ReaderView searchParams={await searchParams} />;
}
