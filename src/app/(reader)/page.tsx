import { ReaderView, type ReaderSearchParams } from "./reader-view";

/** `GET /` — the three-pane reader, scoped to every subscribed feed (§3). */
export default async function ReaderPage({
  searchParams,
}: {
  searchParams: Promise<ReaderSearchParams>;
}) {
  return <ReaderView searchParams={await searchParams} />;
}
