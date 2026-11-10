import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

export function money(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function fmt(d: Date | null | undefined, tz: string, pattern = "d MMM yyyy, HH:mm"): string {
  if (!d) return "—";
  return format(new TZDate(d.getTime(), tz), pattern);
}

export function fmtDate(d: Date | null | undefined, tz: string): string {
  return fmt(d, tz, "d MMM yyyy");
}

export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
