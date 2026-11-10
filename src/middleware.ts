import { NextResponse, type NextRequest } from "next/server";

// Cheap gate: bounce visitors without a session cookie. Real auth/role checks happen server-side.
export function middleware(req: NextRequest) {
  if (!req.cookies.get("ls_session")) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/portal/:path*"] };
