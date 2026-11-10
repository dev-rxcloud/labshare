import { TZDate } from "@date-fns/tz";

/** A billing period, formatted "YYYY-MM". */
export type Period = string;

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parsePeriod(period: Period): { year: number; month: number } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period "${period}", expected YYYY-MM`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function formatPeriod(year: number, month: number): Period {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** UTC instants bounding a period in the facility's local time zone: [start, end). */
export function periodBounds(period: Period, tz: string): { start: Date; end: Date } {
  const { year, month } = parsePeriod(period);
  const start = new TZDate(year, month - 1, 1, 0, 0, 0, tz);
  const end = new TZDate(year, month, 1, 0, 0, 0, tz);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

/** Period containing the given instant, in facility local time. */
export function periodOf(at: Date, tz: string): Period {
  const local = new TZDate(at.getTime(), tz);
  return formatPeriod(local.getFullYear(), local.getMonth() + 1);
}

export function previousPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 1 ? formatPeriod(year - 1, 12) : formatPeriod(year, month - 1);
}

export function nextPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

/** Local wall-clock parts of an instant in the facility time zone. */
export function localParts(at: Date, tz: string) {
  const d = new TZDate(at.getTime(), tz);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(),
  };
}

/** Build a UTC instant from facility-local "YYYY-MM-DD" and "HH:MM". */
export function fromLocal(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) throw new Error("Invalid date/time");
  return new Date(new TZDate(y, mo - 1, d, h, mi, 0, tz).getTime());
}

/** Start/end UTC instants of a facility-local calendar day. */
export function localDayBounds(date: string, tz: string): { start: Date; end: Date } {
  const start = fromLocal(date, "00:00", tz);
  const [y, mo, d] = date.split("-").map(Number);
  const end = new Date(new TZDate(y, mo - 1, d + 1, 0, 0, 0, tz).getTime());
  return { start, end };
}

export function localDateString(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60000);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}
