import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/domain/booking-rules";
import { addDays, fromLocal, localDateString, localDayBounds, localParts } from "@/lib/domain/time";
import { BookingError, accessFor, createBooking } from "@/lib/services/bookings";
import { errMsg, flash, int, str } from "@/lib/actions";
import { fmt, hoursLabel, money } from "@/lib/format";
import { Card, Flash, PageHeader } from "@/components/ui";

async function book(fd: FormData) {
  "use server";
  const user = await requireCustomerUser();
  const s = await getSettings();
  const equipmentId = str(fd, "equipmentId");
  const date = str(fd, "date");
  const back = `/portal/equipment/${equipmentId}?date=${date}`;
  try {
    const startsAt = fromLocal(date, str(fd, "start"), s.timezone);
    const endsAt = new Date(startsAt.getTime() + int(fd, "duration") * 60000);
    const b = await createBooking({ userId: user.id, equipmentId, startsAt, endsAt, purpose: str(fd, "purpose") });
    flash("/portal/bookings", "ok", b.status === "PENDING_APPROVAL" ? "Request submitted. The facility will review it and email you." : "Booking confirmed.");
  } catch (e) {
    flash(back, "error", e instanceof BookingError ? e.message : errMsg(e));
  }
}

export default async function EquipmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; ok?: string; error?: string }> }) {
  const user = await requireCustomerUser();
  const { id } = await params;
  const sp = await searchParams;
  const s = await getSettings();
  const equipment = await prisma.equipment.findUnique({ where: { id }, include: { category: true } });
  if (!equipment) notFound();
  const access = await accessFor(user.id, id);
  const rate = (await prisma.customerEquipmentRate.findUnique({ where: { customerId_equipmentId: { customerId: user.customer.id, equipmentId: id } } }))?.hourlyRateCents ?? equipment.hourlyRateCents;

  const today = localDateString(new Date(), s.timezone);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const { start: dayStart, end: dayEnd } = localDayBounds(date, s.timezone);
  const [bookings, maintenance] = await Promise.all([
    prisma.booking.findMany({
      where: { equipmentId: id, status: { in: [...ACTIVE_BOOKING_STATUSES] }, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      orderBy: { startsAt: "asc" },
    }),
    prisma.maintenanceWindow.findMany({ where: { equipmentId: id, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } } }),
  ]);

  const fromH = equipment.bookableFromHour;
  const toH = equipment.bookableToHour;
  const span = (toH - fromH) * 60;
  const pos = (d: Date) => {
    const clamped = Math.min(Math.max(d.getTime(), dayStart.getTime()), dayEnd.getTime());
    const p = localParts(new Date(clamped), s.timezone);
    const mins = clamped === dayEnd.getTime() ? 24 * 60 : p.hour * 60 + p.minute;
    return Math.min(100, Math.max(0, ((mins - fromH * 60) / span) * 100));
  };
  const startOptions: string[] = [];
  for (let m = fromH * 60; m + equipment.minBookingMinutes <= toH * 60; m += s.slotMinutes)
    startOptions.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  const durations: number[] = [];
  for (let d = equipment.minBookingMinutes; d <= equipment.maxBookingMinutes; d += s.slotMinutes) durations.push(d);
  const dayNav = (offset: number) => localDateString(addDays(fromLocal(date, "12:00", s.timezone), offset), s.timezone);

  return (
    <>
      <PageHeader
        title={equipment.name}
        subtitle={`${equipment.category.name} · ${equipment.location ?? ""} · ${money(rate, s.currency)}/h, billed in ${equipment.billingIncrementMinutes}-minute increments`}
        actions={<Link href="/portal/equipment" className="btn-secondary">All equipment</Link>}
      />
      <Flash searchParams={sp} />
      {equipment.description && <p className="mb-4 text-sm text-slate-600">{equipment.description}</p>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={`Availability · ${fmt(fromLocal(date, "12:00", s.timezone), s.timezone, "EEEE d MMMM yyyy")}`}
          actions={
            <div className="flex gap-1 text-sm">
              <Link className="btn-secondary" href={`?date=${dayNav(-1)}`}>←</Link>
              <Link className="btn-secondary" href={`?date=${today}`}>Today</Link>
              <Link className="btn-secondary" href={`?date=${dayNav(1)}`}>→</Link>
            </div>
          }
        >
          <div className="relative mt-6 h-14 rounded-md bg-emerald-50 ring-1 ring-emerald-200">
            {Array.from({ length: toH - fromH + 1 }, (_, i) => fromH + i).map((h) => (
              <div key={h} className="absolute top-0 h-full border-l border-emerald-200/70" style={{ left: `${((h - fromH) / (toH - fromH)) * 100}%` }}>
                <span className="absolute -top-5 -translate-x-1/2 text-[10px] text-slate-400">{h}</span>
              </div>
            ))}
            {bookings.map((b) => (
              <div
                key={b.id}
                title={`${fmt(b.startsAt, s.timezone, "HH:mm")}–${fmt(b.endsAt, s.timezone, "HH:mm")}`}
                className={`absolute top-1 bottom-1 rounded px-1 text-[10px] leading-tight text-white ${b.customerId === user.customer.id ? "bg-brand-600" : "bg-slate-500"}`}
                style={{ left: `${pos(b.startsAt)}%`, width: `${Math.max(0.5, pos(b.endsAt) - pos(b.startsAt))}%` }}
              >
                {b.customerId === user.customer.id ? "Yours" : "Booked"}
              </div>
            ))}
            {maintenance.map((m) => (
              <div key={m.id} className="absolute top-1 bottom-1 rounded bg-amber-400/80 px-1 text-[10px] text-amber-950" style={{ left: `${pos(m.startsAt)}%`, width: `${pos(m.endsAt) - pos(m.startsAt)}%` }}>
                Maintenance
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-xs text-slate-500">
            <span><span className="mr-1 inline-block h-2 w-2 rounded bg-emerald-200" />free</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded bg-slate-500" />booked</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded bg-brand-600" />your organisation</span>
            {equipment.bufferMinutes > 0 && <span>{equipment.bufferMinutes} min cleanup is kept free between bookings</span>}
          </div>
          {bookings.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm text-slate-600">
              {bookings.map((b) => (
                <li key={b.id}>{fmt(b.startsAt, s.timezone, "HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")} · {b.customerId === user.customer.id ? "your organisation" : "booked"}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Book a slot">
          {!access.allowed ? (
            <p className="text-sm text-slate-600">{access.message}</p>
          ) : (
            <form action={book} className="space-y-3">
              <input type="hidden" name="equipmentId" value={equipment.id} />
              <div>
                <label className="label">Date</label>
                <input className="input" type="date" name="date" defaultValue={date} min={today} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Start</label>
                  <select className="input" name="start" required>
                    {startOptions.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Duration</label>
                  <select className="input" name="duration" defaultValue={Math.min(60, equipment.maxBookingMinutes) >= equipment.minBookingMinutes ? 60 : equipment.minBookingMinutes}>
                    {durations.map((d) => <option key={d} value={d}>{hoursLabel(d)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Purpose (optional)</label>
                <input className="input" name="purpose" placeholder="Project / experiment" />
              </div>
              <button className="btn-primary w-full">{equipment.requiresApproval ? "Request booking" : "Book"}</button>
              <p className="text-xs text-slate-500">
                You are billed for actual use (check-in to check-out), never less than the booked slot. Cancelling less than {s.lateCancelWindowHours}h before start costs {s.lateCancelFeePercent}% of the slot; no-shows cost {s.noShowFeePercent}%.
              </p>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
