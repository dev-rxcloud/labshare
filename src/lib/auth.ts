import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { prisma } from "./db";

const COOKIE = "ls_session";
const MAX_AGE = 60 * 60 * 12; // 12 hours

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ chars)");
  return new TextEncoder().encode(s);
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}

export async function verifyCredentials(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.active) return null;
  return (await bcrypt.compare(password, user.passwordHash)) ? user : null;
}

export async function createSession(userId: string) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { customer: { include: { tier: true } } } });
    return user && user.active ? user : null;
  } catch {
    return null;
  }
}

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof currentUser>>>;

export const FACILITY_ROLES: Role[] = ["FACILITY_ADMIN", "FACILITY_STAFF"];
export const CUSTOMER_ROLES: Role[] = ["CUSTOMER_ADMIN", "CUSTOMER_MEMBER"];

export function isFacility(u: { role: Role }) {
  return FACILITY_ROLES.includes(u.role);
}

/** Use in server components/actions. Redirects to login or home if not permitted. */
export async function requireUser(roles?: Role[]): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect(isFacility(user) ? "/admin" : "/portal");
  return user;
}

export async function requireCustomerUser() {
  const user = await requireUser(CUSTOMER_ROLES);
  if (!user.customer) redirect("/login");
  return user as CurrentUser & { customer: NonNullable<CurrentUser["customer"]> };
}
