import { notFound } from "next/navigation";

import { strictId } from "@/lib/view-params";

import { ReaderView, type ReaderSearchParams } from "../../reader-view";

/** `GET /feed/:id` — the same shell scoped to one feed (§3). */
export default async function FeedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ReaderSearchParams>;
}) {
  const { id } = await params;
  // Strict: `12abc`, `0012` and `12.9` are 404s, not aliases for feed 12. One
  // feed with unlimited URLs is one article with unlimited addresses, which is
  // the problem this whole project is organised against.
  const feedId = strictId(id);
  if (feedId === null) notFound();

  return <ReaderView searchParams={await searchParams} feedId={feedId} />;
}
