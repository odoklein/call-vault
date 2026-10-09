// Sends anonymous visitors to /login. This only checks that a session cookie is present — every page,
// server action and /media route re-validates the session against the DB (lib/auth/session.ts) and
// applies lib/access.ts. /api/* is excluded: those routes authenticate Bearer API keys themselves.

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "cv_session"; // keep in sync with lib/auth/session.ts

export function proxy(req: NextRequest) {
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api/|login|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
