import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/domain/booking-rules";
import { addDays, fromLocal, localDateString, localDayBounds, localParts } from "@/lib/domain/time";
import { BookingError, accessFor, createBooking } from "@/lib/services/bookings";
import { errMsg, flash, int, str } from "@/lib/actions";
import { fmt, money } from "@/lib/format";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Flash, PageHeader } from "@/components/ui";
import { SlotPicker, type PickerBlock, type PickerDay } from "@/components/slot-picker";

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

  const now = new Date();
  const today = localDateString(now, s.timezone);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  // Week (Mon–Sun, facility time) containing the requested date.
  const noon = fromLocal(date, "12:00", s.timezone);
  const monday = addDays(noon, -((localParts(noon, s.timezone).weekday + 6) % 7));
  const dates = Array.from({ length: 7 }, (_, i) => localDateString(addDays(monday, i), s.timezone));
  const bounds = dates.map((d) => localDayBounds(d, s.timezone));
  const weekStart = bounds[0].start;
  const weekEnd = bounds[6].end;
  const lastBookable = addDays(now, s.maxAdvanceDays);
  const nowParts = localParts(now, s.timezone);

  const [bookings, maintenance] = await Promise.all([
    prisma.booking.findMany({
      where: { equipmentId: id, status: { in: [...ACTIVE_BOOKING_STATUSES] }, startsAt: { lt: weekEnd }, endsAt: { gt: weekStart } },
      orderBy: { startsAt: "asc" },
    }),
    prisma.maintenanceWindow.findMany({ where: { equipmentId: id, startsAt: { lt: weekEnd }, endsAt: { gt: weekStart } } }),
  ]);

  // Minutes since local midnight of an instant clipped to a day.
  const minuteOf = (d: Date, day: { start: Date; end: Date }) => {
    if (d <= day.start) return 0;
    if (d >= day.end) return 1440;
    const p = localParts(d, s.timezone);
    return p.hour * 60 + p.minute;
  };
  const blocks: PickerBlock[] = [];
  const addBlock = (startsAt: Date, endsAt: Date, kind: PickerBlock["kind"], label: string) =>
    bounds.forEach((day, i) => {
      if (startsAt < day.end && endsAt > day.start) blocks.push({ day: i, start: minuteOf(startsAt, day), end: minuteOf(endsAt, day), kind, label });
    });
  for (const b of bookings) {
    const mine = b.customerId === user.customer.id;
    const when = `${fmt(b.startsAt, s.timezone, "HH:mm")}–${fmt(b.endsAt, s.timezone, "HH:mm")}`;
    addBlock(b.startsAt, b.endsAt, mine ? "mine" : "booked", mine ? `Yours ${when}${b.status === "PENDING_APPROVAL" ? " (pending)" : ""}` : `Booked ${when}`);
  }
  for (const m of maintenance) addBlock(m.startsAt, m.endsAt, "maintenance", `Maintenance${m.reason ? ` · ${m.reason}` : ""}`);

  const days: PickerDay[] = dates.map((d, i) => ({
    date: d,
    weekday: fmt(fromLocal(d, "12:00", s.timezone), s.timezone, "EEE"),
    dayNum: String(Number(d.slice(8))),
    isToday: d === today,
    pastUntil: d < today ? 1440 : d === today ? nowParts.hour * 60 + nowParts.minute : 0,
    bookable: bounds[i].start < lastBookable,
  }));
  const weekNav = (offset: number) => localDateString(addDays(noon, offset * 7), s.timezone);
  const rangeLabel = `${fmt(bounds[0].start, s.timezone, "d MMM")} – ${fmt(addDays(bounds[6].start, 0), s.timezone, "d MMM yyyy")}`;

  return (
    <>
      <PageHeader
        title={equipment.name}
        subtitle={`${equipment.category.name} · ${equipment.location ?? ""} · ${money(rate, s.currency)}/h, billed in ${equipment.billingIncrementMinutes}-minute increments`}
        actions={<Link href="/portal/equipment" className="btn-secondary">All equipment</Link>}
      />
      <Flash searchParams={sp} />
      {equipment.description && <p className="mb-4 text-sm font-medium">{equipment.description}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link className="btn-secondary" href={`?date=${today}`}>Today</Link>
        <Link className="btn-secondary w-9 px-0" href={`?date=${weekNav(-1)}`} aria-label="Previous week"><ChevronLeft size={18} className="h-[18px] w-[18px] shrink-0" /></Link>
        <Link className="btn-secondary w-9 px-0" href={`?date=${weekNav(1)}`} aria-label="Next week"><ChevronRight size={18} className="h-[18px] w-[18px] shrink-0" /></Link>
        <span className="ml-2 text-lg font-bold">{rangeLabel}</span>
      </div>
      <SlotPicker
        days={days}
        blocks={blocks}
        fromHour={equipment.bookableFromHour}
        toHour={equipment.bookableToHour}
        slot={s.slotMinutes}
        minMinutes={equipment.minBookingMinutes}
        maxMinutes={equipment.maxBookingMinutes}
        bufferMinutes={equipment.bufferMinutes}
        rateCents={rate}
        currency={s.currency}
        requiresApproval={equipment.requiresApproval}
        canBook={access.allowed}
        accessMessage={access.message}
        equipmentId={equipment.id}
        initialDay={Math.max(0, dates.indexOf(date))}
        policyText={`You're billed for actual use (check-in to check-out), never less than the booked slot. Cancelling less than ${s.lateCancelWindowHours}h before the start costs ${s.lateCancelFeePercent}% of the slot; no-shows cost ${s.noShowFeePercent}%.`}
        action={book}
      />
    </>
  );
}
