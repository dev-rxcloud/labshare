import { redirect } from "next/navigation";

/** Redirect back with a flash message in the query string. */
export function flash(path: string, kind: "ok" | "error", message: string): never {
  const url = new URL(path, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  url.searchParams.set(kind, message);
  redirect(url.pathname + url.search);
}

export function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

export function int(fd: FormData, key: string, fallback = 0): number {
  const v = str(fd, key);
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return Math.round(n);
}

/** Parse a dollars field like "125.50" into cents. */
export function centsField(fd: FormData, key: string): number {
  const v = str(fd, key).replace(/[$,\s]/g, "");
  if (v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be an amount`);
  return Math.round(n * 100);
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw e;
  return e instanceof Error ? e.message : String(e);
}
