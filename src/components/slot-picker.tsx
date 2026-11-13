"use client";

/*
 * Outlook-style week calendar for booking equipment.
 * Drag down a day column to select a slot (or click once for the default length). Existing bookings,
 * maintenance, cleanup buffers, past time, bookable hours and min/max length are enforced as you drag;
 * the server re-validates everything on submit.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CalendarClock, Info } from "lucide-react";

export interface PickerDay {
  date: string; // YYYY-MM-DD (facility local)
  weekday: string; // "Mon"
  dayNum: string; // "12"
  isToday: boolean;
  pastUntil: number; // minutes since local midnight before which the day is in the past (0..1440)
  bookable: boolean; // within the advance-booking window
}

export interface PickerBlock {
  day: number; // index into days
  start: number; // minutes since local midnight
  end: number;
  kind: "mine" | "booked" | "maintenance";
  label: string;
}

interface Props {
  days: PickerDay[];
  blocks: PickerBlock[];
  fromHour: number;
  toHour: number;
  slot: number;
  minMinutes: number;
  maxMinutes: number;
  bufferMinutes: number;
  rateCents: number;
  currency: string;
  requiresApproval: boolean;
  canBook: boolean;
  accessMessage?: string;
  equipmentId: string;
  initialDay: number;
  policyText: string;
  action: (fd: FormData) => void | Promise<void>;
}

const PX_PER_HOUR = 56;
const ppm = PX_PER_HOUR / 60;

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const durLabel = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`).replace(/^0h /, "");

type Sel = { day: number; start: number; end: number };

export function SlotPicker(p: Props) {
  const lo = p.fromHour * 60;
  const hi = p.toHour * 60;
  const [sel, setSel] = useState<Sel | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const drag = useRef<{ day: number; anchor: number; moved: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Start the view around the working day, like Outlook.
  useEffect(() => {
    const first = Math.max(lo, Math.min(8 * 60, hi - 8 * 60));
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (first - lo) * ppm - 10);
  }, [lo, hi]);

  const byDay = useMemo(() => {
    const m = new Map<number, PickerBlock[]>();
    for (const b of p.blocks) m.set(b.day, [...(m.get(b.day) ?? []), b]);
    return m;
  }, [p.blocks]);

  /** Why a [start,end) range on a day can't be booked, or null if it can. */
  function problem(day: number, start: number, end: number): string | null {
    const d = p.days[day];
    if (!d.bookable) return "That day is beyond the advance-booking window.";
    if (start < d.pastUntil) return "That time has already passed.";
    if (start < lo || end > hi) return `Bookable ${hhmm(lo)}–${hhmm(hi)} only.`;
    for (const b of byDay.get(day) ?? []) {
      const pad = b.kind === "maintenance" ? 0 : p.bufferMinutes;
      if (start < b.end + pad && b.start - pad < end)
        return b.kind === "maintenance" ? "Overlaps scheduled maintenance." : p.bufferMinutes ? `Overlaps a booking or its ${p.bufferMinutes}-minute cleanup time.` : "Overlaps another booking.";
    }
    return null;
  }

  /** Grow a range from `start` towards `wantEnd`, stopping before the first conflict or the max length. */
  function grow(day: number, start: number, wantEnd: number) {
    let end = start;
    const limit = Math.min(wantEnd, start + p.maxMinutes, hi);
    while (end + p.slot <= limit && !problem(day, start, end + p.slot)) end += p.slot;
    return end;
  }
  /** Same, growing upwards from a fixed end. */
  function growUp(day: number, end: number, wantStart: number) {
    let start = end;
    const limit = Math.max(wantStart, end - p.maxMinutes, lo);
    while (start - p.slot >= limit && !problem(day, start - p.slot, end)) start -= p.slot;
    return start;
  }

  function minuteAt(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = Math.max(0, Math.min(e.clientY - rect.top, (hi - lo) * ppm - 1));
    return lo + Math.floor(y / ppm / p.slot) * p.slot;
  }

  function onDown(day: number, e: ReactPointerEvent<HTMLDivElement>) {
    if (!p.canBook || e.button !== 0) return;
    const m = minuteAt(e);
    const why = problem(day, m, m + p.slot);
    if (why) {
      setHint(why);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { day, anchor: m, moved: false };
    setHint(null);
    setSel({ day, start: m, end: m + p.slot });
  }

  function onMove(day: number, e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.day !== day) return;
    const m = minuteAt(e);
    if (m !== d.anchor) d.moved = true;
    if (m >= d.anchor) setSel({ day, start: d.anchor, end: Math.max(d.anchor + p.slot, grow(day, d.anchor, m + p.slot)) });
    else setSel({ day, start: growUp(day, d.anchor + p.slot, m), end: d.anchor + p.slot });
  }

  function onUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setSel((cur) => {
      if (!cur) return cur;
      // A plain click picks the default length (1h, within the instrument's limits).
      if (!d.moved) {
        const want = Math.min(Math.max(60, p.minMinutes), p.maxMinutes);
        return { ...cur, end: Math.max(cur.start + p.slot, grow(cur.day, cur.start, cur.start + want)) };
      }
      return cur;
    });
  }

  const duration = sel ? sel.end - sel.start : 0;
  const selProblem = sel
    ? problem(sel.day, sel.start, sel.end) ??
      (duration < p.minMinutes ? `Minimum booking is ${durLabel(p.minMinutes)}; there isn't enough free time here.` : duration > p.maxMinutes ? `Maximum booking is ${durLabel(p.maxMinutes)}.` : null)
    : null;
  const valid = !!sel && !selProblem;

  // Options for fine-tuning from the form (also the keyboard-accessible path).
  const startOptions: number[] = [];
  for (let m = lo; m + p.minMinutes <= hi; m += p.slot) startOptions.push(m);
  const durOptions: number[] = [];
  for (let d = p.minMinutes; d <= p.maxMinutes; d += p.slot) durOptions.push(d);
  const formDay = sel?.day ?? p.initialDay;

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency });
  const hours = Array.from({ length: p.toHour - p.fromHour }, (_, i) => p.fromHour + i);
  const height = (hi - lo) * ppm;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Day headers */}
            <div className="grid grid-cols-[56px_repeat(7,1fr)] border-b border-secondary-grey">
              <div />
              {p.days.map((d, i) => (
                <div key={d.date} className={`px-2 py-3 text-center ${!d.bookable || d.pastUntil >= 1440 ? "italic" : ""}`}>
                  <div className="text-xs font-bold">{d.weekday}</div>
                  <div
                    className={`mx-auto mt-1 flex h-8 w-8 items-center justify-center rounded-full text-base font-bold ${
                      d.isToday ? "bg-deep-blue text-canvas" : sel?.day === i ? "bg-secondary-aqua" : ""
                    }`}
                  >
                    {d.dayNum}
                  </div>
                </div>
              ))}
            </div>
            {/* Time grid */}
            <div ref={scroller} className="max-h-[560px] overflow-y-auto">
              <div className="relative mt-2 mb-2 grid grid-cols-[56px_repeat(7,1fr)]" style={{ height }}>
                <div className="relative">
                  {hours.map((h) => (
                    <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] font-bold" style={{ top: (h * 60 - lo) * ppm }}>
                      {h === p.fromHour ? "" : hhmm(h * 60)}
                    </div>
                  ))}
                </div>
                {p.days.map((d, di) => {
                  const pastPx = Math.max(0, Math.min(hi, d.bookable ? d.pastUntil : 1440) - lo) * ppm;
                  return (
                    <div
                      key={d.date}
                      role="presentation"
                      className={`relative border-l border-secondary-grey select-none touch-none ${p.canBook ? "cursor-crosshair" : ""}`}
                      onPointerDown={(e) => onDown(di, e)}
                      onPointerMove={(e) => onMove(di, e)}
                      onPointerUp={onUp}
                      onPointerCancel={onUp}
                    >
                      {/* hour lines */}
                      {hours.map((h) => (
                        <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-secondary-grey" style={{ top: (h * 60 - lo) * ppm }} />
                      ))}
                      {/* past / not-bookable time */}
                      {pastPx > 0 && <div className="pointer-events-none absolute inset-x-0 top-0 bg-secondary-grey" style={{ height: Math.min(pastPx, height) }} />}
                      {/* existing bookings and maintenance */}
                      {(byDay.get(di) ?? []).map((b, bi) => {
                        const top = (Math.max(b.start, lo) - lo) * ppm;
                        const h = (Math.min(b.end, hi) - Math.max(b.start, lo)) * ppm;
                        if (h <= 0) return null;
                        const cls =
                          b.kind === "mine" ? "bg-forest-green-text text-canvas" : b.kind === "booked" ? "bg-deep-blue text-canvas" : "border-2 border-deep-blue bg-secondary-yellow text-deep-blue";
                        return (
                          <div key={bi} title={b.label} className={`pointer-events-none absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-1 text-[11px] leading-tight font-bold ${cls}`} style={{ top, height: Math.max(h - 2, 6) }}>
                            {h >= 28 && b.label}
                          </div>
                        );
                      })}
                      {/* current time */}
                      {d.isToday && d.pastUntil > lo && d.pastUntil < hi && (
                        <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-forest-green" style={{ top: (d.pastUntil - lo) * ppm }} />
                      )}
                      {/* selection */}
                      {sel && sel.day === di && (
                        <div
                          className={`pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-deep-blue px-1.5 py-1 text-[11px] leading-tight font-bold text-deep-blue ${
                            selProblem ? "bg-secondary-yellow" : "bg-secondary-aqua"
                          }`}
                          style={{ top: (sel.start - lo) * ppm, height: Math.max((sel.end - sel.start) * ppm - 2, 8) }}
                        >
                          {hhmm(sel.start)}–{hhmm(sel.end)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-secondary-grey px-5 py-3 text-xs font-medium">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-deep-blue bg-secondary-aqua" />your selection</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-forest-green-text" />your organisation</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-deep-blue" />booked</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-deep-blue bg-secondary-yellow" />maintenance</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-secondary-grey" />past</span>
          {p.bufferMinutes > 0 && <span>{p.bufferMinutes} min cleanup is kept free around bookings</span>}
        </div>
      </section>

      <aside className="card h-fit p-5 lg:sticky lg:top-6">
        <h2 className="flex items-center gap-2 text-[15px] font-bold"><CalendarClock size={18} aria-hidden /> Book a slot</h2>
        {!p.canBook ? (
          <p className="mt-3 text-sm font-medium">{p.accessMessage}</p>
        ) : (
          <form action={p.action} className="mt-4 space-y-4">
            <input type="hidden" name="equipmentId" value={p.equipmentId} />
            <input type="hidden" name="date" value={p.days[formDay].date} />
            {!sel ? (
              <div className="flex gap-2 rounded-xl border border-dashed border-secondary-grey p-4 text-sm font-medium">
                <Info size={18} className="mt-px shrink-0" aria-hidden />
                <span>Drag on the calendar to choose a time, or click once for a {durLabel(Math.min(Math.max(60, p.minMinutes), p.maxMinutes))} slot. You can fine-tune it below.</span>
              </div>
            ) : (
              <div className={`rounded-xl px-4 py-3 ${valid ? "bg-secondary-aqua" : "notice-problem block"}`}>
                <div className="text-sm font-bold">
                  {p.days[sel.day].weekday} {p.days[sel.day].dayNum} · {hhmm(sel.start)}–{hhmm(sel.end)}
                </div>
                <div className="text-xs font-semibold">
                  {selProblem ?? `${durLabel(duration)} · about ${money.format((p.rateCents * duration) / 60 / 100)} at list rate`}
                </div>
              </div>
            )}
            {hint && !sel && <div className="notice-problem text-xs">{hint}</div>}
            <div>
              <label className="label" htmlFor="sp-day">Day</label>
              <select
                id="sp-day"
                className="input"
                value={formDay}
                onChange={(e) => {
                  const day = Number(e.target.value);
                  const start = sel?.start ?? Math.max(lo, 9 * 60);
                  const len = sel ? duration : Math.min(Math.max(60, p.minMinutes), p.maxMinutes);
                  setSel({ day, start, end: start + len });
                }}
              >
                {p.days.map((d, i) => (
                  <option key={d.date} value={i} disabled={!d.bookable || d.pastUntil >= hi}>{d.weekday} {d.dayNum}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="sp-start">Start</label>
                <select
                  id="sp-start"
                  name="start"
                  className="input"
                  value={hhmm(sel?.start ?? lo)}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    const start = h * 60 + m;
                    const len = sel ? duration : Math.min(Math.max(60, p.minMinutes), p.maxMinutes);
                    setSel({ day: formDay, start, end: start + len });
                  }}
                >
                  {startOptions.map((m) => <option key={m} value={hhmm(m)}>{hhmm(m)}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="sp-dur">Duration</label>
                <select
                  id="sp-dur"
                  name="duration"
                  className="input"
                  value={sel ? duration : Math.min(Math.max(60, p.minMinutes), p.maxMinutes)}
                  onChange={(e) => {
                    const len = Number(e.target.value);
                    const start = sel?.start ?? Math.max(lo, 9 * 60);
                    setSel({ day: formDay, start, end: start + len });
                  }}
                >
                  {!durOptions.includes(duration) && sel && <option value={duration}>{durLabel(duration)}</option>}
                  {durOptions.map((d) => <option key={d} value={d}>{durLabel(d)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="sp-purpose">Purpose (optional)</label>
              <input id="sp-purpose" className="input" name="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Project / experiment" />
            </div>
            <button className="btn-primary h-11 w-full" disabled={!valid}>
              {p.requiresApproval ? "Request booking" : "Book"}
              {valid && sel ? ` ${hhmm(sel.start)}–${hhmm(sel.end)}` : ""}
            </button>
            <p className="text-xs font-medium leading-relaxed">{p.policyText}</p>
          </form>
        )}
      </aside>
    </div>
  );
}
