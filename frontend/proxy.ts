import { NextResponse, type NextRequest } from "next/server";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";

/**
 * Reading is open to everyone; only the admin pages sit behind the password. The admin server actions check the
 * cookie themselves (`app/actions/admin.ts`), since an action can be posted from any page, not only these.
 */
export async function proxy(request: NextRequest) {
  if (await hasAccess(request.cookies.get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
