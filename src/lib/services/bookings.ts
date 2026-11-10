import { Prisma, type BookingStatus } from "@prisma/client";
import { prisma } from "../db";
import { getSettings } from "../settings";
import { audit } from "../audit";
import {
  ACTIVE_BOOKING_STATUSES,
  cancellationTerms,
  checkAccess,
  validateBooking,
  type AccessResult,
  type ValidationError,
} from "../domain/booking-rules";
import { addMinutes, minutesBetween, periodBounds, periodOf } from "../domain/time";
import { sendEmail } from "./email";
import { fmt } from "../format";

export class BookingError extends Error {
  constructor(public errors: ValidationError[]) {
    super(errors.map((e) => e.message).join(" "));
  }
}

const CHECK_IN_EARLY_MINUTES = 15;

async function loadContext(tx: Prisma.TransactionClient, userId: string, equipmentId: string) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { customer: { include: { tier: true } } } });
  if (!user.customer) throw new BookingError([{ code: "USER_NOT_CUSTOMER", message: "Only customer members can book equipment." }]);
  const equipment = await tx.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
  const [grant, certification, rateOverride] = await Promise.all([
    tx.equipmentGrant.findUnique({ where: { customerId_equipmentId: { customerId: user.customer.id, equipmentId } } }),
    tx.userCertification.findUnique({ where: { userId_equipmentId: { userId, equipmentId } } }),
    tx.customerEquipmentRate.findUnique({ where: { customerId_equipmentId: { customerId: user.customer.id, equipmentId } } }),
  ]);
  return { user, customer: user.customer, equipment, grant, certification, rateOverride };
}

type Ctx = Awaited<ReturnType<typeof loadContext>>;

function accessInput(c: Ctx, now: Date) {
  return {
    user: { id: c.user.id, active: c.user.active, role: c.user.role, customerId: c.user.customerId },
    customer: { id: c.customer.id, status: c.customer.status, tierLevel: c.customer.tier.level, monthlyHourQuota: c.customer.monthlyHourQuota },
    equipment: c.equipment,
    hasGrant: !!c.grant,
    certification: c.certification ? { expiresAt: c.certification.expiresAt } : null,
    now,
  };
}

/** Explain whether a user may book an equipment item at all (used by the catalog UI). */
export async function accessFor(userId: string, equipmentId: string): Promise<AccessResult> {
  try {
    const c = await loadContext(prisma, userId, equipmentId);
    return checkAccess(accessInput(c, new Date()));
  } catch (e) {
    if (e instanceof BookingError) return { allowed: false, code: e.errors[0].code as never, message: e.message };
    throw e;
  }
}

export async function customerHoursInPeriod(tx: Prisma.TransactionClient, customerId: string, at: Date, tz: string, excludeId?: string) {
  const { start, end } = periodBounds(periodOf(at, tz), tz);
  const bookings = await tx.booking.findMany({
    where: {
      customerId,
      startsAt: { gte: start, lt: end },
      status: { in: ["PENDING_APPROVAL", "CONFIRMED", "CHECKED_IN", "COMPLETED"] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { startsAt: true, endsAt: true },
  });
  return bookings.reduce((h, b) => h + minutesBetween(b.startsAt, b.endsAt) / 60, 0);
}

export async function createBooking(input: { userId: string; equipmentId: string; startsAt: Date; endsAt: Date; purpose?: string }) {
  const settings = await getSettings();
  const now = new Date();
  try {
    const booking = await prisma.$transaction(
      async (tx) => {
        const c = await loadContext(tx, input.userId, input.equipmentId);
        const buffer = c.equipment.bufferMinutes;
        const windowStart = addMinutes(input.startsAt, -buffer);
        const windowEnd = addMinutes(input.endsAt, buffer);
        const [existing, maintenance, hours] = await Promise.all([
          tx.booking.findMany({
            where: {
              equipmentId: input.equipmentId,
              status: { in: [...ACTIVE_BOOKING_STATUSES] },
              startsAt: { lt: windowEnd },
              endsAt: { gt: windowStart },
            },
            select: { startsAt: true, endsAt: true },
          }),
          tx.maintenanceWindow.findMany({
            where: { equipmentId: input.equipmentId, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } },
          }),
          customerHoursInPeriod(tx, c.customer.id, input.startsAt, settings.timezone),
        ]);
        const errors = validateBooking({
          ...accessInput(c, now),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: settings.timezone,
          slotMinutes: settings.slotMinutes,
          maxAdvanceDays: settings.maxAdvanceDays,
          existing,
          maintenance,
          customerHoursInPeriod: hours,
        });
        if (errors.length) throw new BookingError(errors);
        return tx.booking.create({
          data: {
            equipmentId: input.equipmentId,
            userId: input.userId,
            customerId: c.customer.id,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            purpose: input.purpose?.trim() || null,
            hourlyRateCents: c.rateOverride?.hourlyRateCents ?? c.equipment.hourlyRateCents,
            status: c.equipment.requiresApproval ? "PENDING_APPROVAL" : "CONFIRMED",
          },
          include: { equipment: true, user: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await audit(input.userId, "booking.create", "Booking", booking.id, { status: booking.status });
    await sendEmail({
      to: [booking.user.email],
      subject: `${booking.status === "PENDING_APPROVAL" ? "Booking request received" : "Booking confirmed"}: ${booking.equipment.name}`,
      body: `${booking.equipment.name}\n${fmt(booking.startsAt, settings.timezone)} – ${fmt(booking.endsAt, settings.timezone, "HH:mm")}\nStatus: ${booking.status.replace("_", " ").toLowerCase()}`,
      kind: "booking",
      relatedId: booking.id,
    });
    return booking;
  } catch (e) {
    if (isOverlapError(e)) throw new BookingError([{ code: "CONFLICT", message: "Someone just booked this time. Please choose another slot." }]);
    throw e;
  }
}

function isOverlapError(e: unknown) {
  const msg = String((e as Error)?.message ?? "");
  const code = (e as { code?: string })?.code;
  return msg.includes("Booking_no_overlap") || code === "P2034" || msg.includes("could not serialize");
}

async function getOwnBooking(userId: string, bookingId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { equipment: true } });
  const sameCustomer = user.customerId && booking.customerId === user.customerId;
  const allowed = booking.userId === userId || (user.role === "CUSTOMER_ADMIN" && sameCustomer);
  if (!allowed) throw new Error("Not allowed");
  return booking;
}

export async function cancelBooking(userId: string, bookingId: string, reason?: string) {
  const settings = await getSettings();
  const booking = await getOwnBooking(userId, bookingId);
  const terms = cancellationTerms(booking, new Date(), settings);
  if (!terms.canCancel) throw new Error("This booking can no longer be cancelled.");
  await prisma.booking.update({
    where: { id: bookingId },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason || (terms.late ? "Late cancellation" : null) },
  });
  await audit(userId, "booking.cancel", "Booking", bookingId, terms);
  return terms;
}

export async function checkIn(userId: string, bookingId: string) {
  const booking = await getOwnBooking(userId, bookingId);
  const now = new Date();
  if (booking.status !== "CONFIRMED") throw new Error("Only confirmed bookings can be checked in.");
  if (now < addMinutes(booking.startsAt, -CHECK_IN_EARLY_MINUTES)) throw new Error(`Check-in opens ${CHECK_IN_EARLY_MINUTES} minutes before the booking.`);
  if (now >= booking.endsAt) throw new Error("This booking has already ended.");
  // Billing starts at the booked start even if checking in early.
  await prisma.booking.update({ where: { id: bookingId }, data: { status: "CHECKED_IN", checkedInAt: now < booking.startsAt ? booking.startsAt : now } });
  await audit(userId, "booking.checkin", "Booking", bookingId);
}

export async function checkOut(userId: string, bookingId: string) {
  const booking = await getOwnBooking(userId, bookingId);
  if (booking.status !== "CHECKED_IN") throw new Error("Only checked-in bookings can be checked out.");
  const now = new Date();
  await prisma.booking.update({ where: { id: bookingId }, data: { status: "COMPLETED", checkedOutAt: now } });
  await audit(userId, "booking.checkout", "Booking", bookingId);
}

/** Facility staff actions */
export async function staffSetStatus(actorId: string, bookingId: string, status: BookingStatus, note?: string) {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { user: true, equipment: true } });
  if (booking.invoiceLineId) throw new Error("This booking is already invoiced. Void the invoice first.");
  const allowed: Record<string, BookingStatus[]> = {
    PENDING_APPROVAL: ["CONFIRMED", "REJECTED"],
    CONFIRMED: ["CANCELLED", "NO_SHOW", "CHECKED_IN"],
    CHECKED_IN: ["COMPLETED"],
    NO_SHOW: ["COMPLETED", "CANCELLED"],
    COMPLETED: ["NO_SHOW"],
  };
  if (!allowed[booking.status]?.includes(status)) throw new Error(`Cannot change ${booking.status} to ${status}.`);
  const data: Prisma.BookingUpdateInput = { status };
  if (status === "CANCELLED") Object.assign(data, { cancelledAt: new Date(), cancelReason: note || "Cancelled by facility" });
  if (status === "CHECKED_IN") data.checkedInAt = booking.startsAt;
  if (status === "COMPLETED" && !booking.checkedOutAt) Object.assign(data, { checkedInAt: booking.checkedInAt ?? booking.startsAt, checkedOutAt: booking.endsAt });
  await prisma.booking.update({ where: { id: bookingId }, data });
  await audit(actorId, `booking.${status.toLowerCase()}`, "Booking", bookingId, { note });
  if (booking.status === "PENDING_APPROVAL") {
    const settings = await getSettings();
    await sendEmail({
      to: [booking.user.email],
      subject: `Booking ${status === "CONFIRMED" ? "approved" : "declined"}: ${booking.equipment.name}`,
      body: `${booking.equipment.name}, ${fmt(booking.startsAt, settings.timezone)}${note ? `\nNote from facility: ${note}` : ""}`,
      kind: "booking",
      relatedId: bookingId,
    });
  }
}

/** Staff correction of actual usage times (e.g. from instrument logs). */
export async function staffSetActualTimes(actorId: string, bookingId: string, checkedInAt: Date, checkedOutAt: Date) {
  if (!(checkedOutAt > checkedInAt)) throw new Error("Check-out must be after check-in.");
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  if (booking.invoiceLineId) throw new Error("This booking is already invoiced. Void the invoice first.");
  await prisma.booking.update({ where: { id: bookingId }, data: { checkedInAt, checkedOutAt, status: "COMPLETED", autoClosed: false } });
  await audit(actorId, "booking.correct_times", "Booking", bookingId, { checkedInAt, checkedOutAt });
}
