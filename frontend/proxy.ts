import { NextResponse, type NextRequest } from "next/server";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";

/** Everything but the login page and static assets sits behind the password. */
export async function proxy(request: NextRequest) {
  if (await hasAccess(request.cookies.get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Enter the password first." }, { status: 401 });
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
