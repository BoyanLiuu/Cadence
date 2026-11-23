import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { CURRENT_PATH_HEADER } from "@/lib/http/current-path";

/*
 * Clerk's middleware, and nothing else.
 *
 * NO ROUTE PROTECTION HERE, which is a change from the plan. It specifies a
 * public-route allowlist in this matcher and warns that a careless entry
 * exposes the wrong page; Clerk 7 inverted that default — every route is
 * public unless something calls `auth.protect()` — so there is no allowlist to
 * get wrong. Protection lives where the ownership rules already are:
 * `assertCan()` for the coarse gate, the `user_id` filter in every query for
 * the per-row one, and `requireViewer()` on the screens.
 *
 * The file is `proxy.ts` rather than `middleware.ts` because Next 16 renamed
 * it.
 */
export default clerkMiddleware((_auth, request) => {
  const headers = new Headers(request.headers);
  headers.set(CURRENT_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
