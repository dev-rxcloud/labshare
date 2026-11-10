/**
 * Pure booking validation. All the "who can book what, when" rules live here so they are
 * unit-testable and shared by the UI (to explain why something is unavailable) and the API.
 */
import { addMinutes, localParts, minutesBetween } from "./time";

export type AccessDenialCode =
  | "CUSTOMER_NOT_ACTIVE"
  | "USER_INACTIVE"
  | "USER_NOT_CUSTOMER"
  | "EQUIPMENT_UNAVAILABLE"
  | "TIER_TOO_LOW"
  | "RESTRICTED_NO_GRANT"
  | "CERTIFICATION_REQUIRED"
  | "CERTIFICATION_EXPIRED";

export type BookingErrorCode =
  | AccessDenialCode
  | "INVALID_RANGE"
  | "IN_PAST"
  | "TOO_FAR_AHEAD"
  | "NOT_ON_SLOT"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "OUTSIDE_BOOKABLE_HOURS"
  | "CONFLICT"
  | "MAINTENANCE"
  | "QUOTA_EXCEEDED";

export interface RuleUser {
  id: string;
  active: boolean;
  role: string;
  customerId: string | null;
}

export interface RuleCustomer {
  id: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CLOSED";
  tierLevel: number;
  monthlyHourQuota: number | null;
}

export interface RuleEquipment {
  id: string;
  status: "ACTIVE" | "MAINTENANCE" | "RETIRED";
  minTierLevel: number;
  restricted: boolean;
  requiresCertification: boolean;
  minBookingMinutes: number;
  maxBookingMinutes: number;
  bufferMinutes: number;
  bookableFromHour: number;
  bookableToHour: number;
}

export interface AccessContext {
  user: RuleUser;
  customer: RuleCustomer;
  equipment: RuleEquipment;
  hasGrant: boolean;
  certification: { expiresAt: Date | null } | null;
  now: Date;
}

export interface AccessResult {
  allowed: boolean;
  code?: AccessDenialCode;
  message?: string;
}

export function checkAccess(ctx: AccessContext): AccessResult {
  const { user, customer, equipment } = ctx;
  if (!user.active) return deny("USER_INACTIVE", "Your user account is inactive.");
  if (!(user.role === "CUSTOMER_ADMIN" || user.role === "CUSTOMER_MEMBER") || user.customerId !== customer.id)
    return deny("USER_NOT_CUSTOMER", "Only members of a customer organisation can book equipment.");
  if (customer.status !== "ACTIVE")
    return deny(
      "CUSTOMER_NOT_ACTIVE",
      customer.status === "SUSPENDED"
        ? "Your organisation's account is suspended. Please contact the facility (this is often due to an overdue invoice)."
        : "Your organisation's account is not active yet.",
    );
  if (equipment.status !== "ACTIVE") return deny("EQUIPMENT_UNAVAILABLE", "This equipment is not currently bookable.");
  if (equipment.restricted && !ctx.hasGrant)
    return deny("RESTRICTED_NO_GRANT", "This equipment is restricted. Your organisation needs a facility grant to use it.");
  if (!equipment.restricted && customer.tierLevel < equipment.minTierLevel && !ctx.hasGrant)
    return deny("TIER_TOO_LOW", "Your organisation's plan does not include this equipment.");
  if (equipment.requiresCertification) {
    if (!ctx.certification) return deny("CERTIFICATION_REQUIRED", "You need training/certification on this equipment before booking.");
    if (ctx.certification.expiresAt && ctx.certification.expiresAt <= ctx.now)
      return deny("CERTIFICATION_EXPIRED", "Your certification for this equipment has expired.");
  }
  return { allowed: true };
}

function deny(code: AccessDenialCode, message: string): AccessResult {
  return { allowed: false, code, message };
}

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

export interface BookingRequestContext extends AccessContext {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  slotMinutes: number;
  maxAdvanceDays: number;
  /** Other active bookings on the same equipment (excluding the one being edited). */
  existing: Interval[];
  maintenance: Interval[];
  /** Hours already booked by the customer in the period of this booking (excluding this one). */
  customerHoursInPeriod: number;
}

export interface ValidationError {
  code: BookingErrorCode;
  message: string;
}

export function validateBooking(ctx: BookingRequestContext): ValidationError[] {
  const errors: ValidationError[] = [];
  const access = checkAccess(ctx);
  if (!access.allowed) return [{ code: access.code!, message: access.message! }];

  const { startsAt, endsAt, equipment, now } = ctx;
  if (!(endsAt > startsAt)) return [{ code: "INVALID_RANGE", message: "End time must be after start time." }];
  if (startsAt < now) errors.push({ code: "IN_PAST", message: "Bookings cannot start in the past." });
  if (startsAt.getTime() - now.getTime() > ctx.maxAdvanceDays * 86400000)
    errors.push({ code: "TOO_FAR_AHEAD", message: `Bookings can be made at most ${ctx.maxAdvanceDays} days ahead.` });

  const duration = minutesBetween(startsAt, endsAt);
  const s = localParts(startsAt, ctx.timezone);
  const e = localParts(endsAt, ctx.timezone);
  if (s.minute % ctx.slotMinutes !== 0 || e.minute % ctx.slotMinutes !== 0 || startsAt.getUTCSeconds() !== 0 || endsAt.getUTCSeconds() !== 0)
    errors.push({ code: "NOT_ON_SLOT", message: `Bookings must start and end on ${ctx.slotMinutes}-minute boundaries.` });
  if (duration < equipment.minBookingMinutes)
    errors.push({ code: "TOO_SHORT", message: `Minimum booking is ${equipment.minBookingMinutes} minutes.` });
  if (duration > equipment.maxBookingMinutes)
    errors.push({ code: "TOO_LONG", message: `Maximum booking is ${equipment.maxBookingMinutes} minutes.` });

  if (equipment.bookableFromHour > 0 || equipment.bookableToHour < 24) {
    const sameDay = s.year === e.year && s.month === e.month && s.day === e.day;
    const endMinutes = sameDay ? e.hour * 60 + e.minute : 24 * 60 + e.hour * 60 + e.minute;
    if (s.hour < equipment.bookableFromHour || endMinutes > equipment.bookableToHour * 60)
      errors.push({
        code: "OUTSIDE_BOOKABLE_HOURS",
        message: `This equipment can be booked between ${equipment.bookableFromHour}:00 and ${equipment.bookableToHour}:00.`,
      });
  }

  const buffer = equipment.bufferMinutes;
  const conflict = ctx.existing.some((b) => overlaps(startsAt, endsAt, addMinutes(b.startsAt, -buffer), addMinutes(b.endsAt, buffer)));
  if (conflict) errors.push({ code: "CONFLICT", message: "This time overlaps another booking (including cleanup time)." });
  if (ctx.maintenance.some((m) => overlaps(startsAt, endsAt, m.startsAt, m.endsAt)))
    errors.push({ code: "MAINTENANCE", message: "This equipment is scheduled for maintenance during that time." });

  if (ctx.customer.monthlyHourQuota != null && ctx.customerHoursInPeriod + duration / 60 > ctx.customer.monthlyHourQuota)
    errors.push({
      code: "QUOTA_EXCEEDED",
      message: `This booking would exceed your organisation's monthly quota of ${ctx.customer.monthlyHourQuota} hours.`,
    });
  return errors;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Statuses that occupy equipment time. */
export const ACTIVE_BOOKING_STATUSES = ["PENDING_APPROVAL", "CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"] as const;

/** Can the booking be cancelled by the customer, and what fee applies? */
export function cancellationTerms(
  booking: { startsAt: Date; status: string },
  now: Date,
  policy: { lateCancelWindowHours: number; lateCancelFeePercent: number },
): { canCancel: boolean; late: boolean; feePercent: number } {
  if (!["PENDING_APPROVAL", "CONFIRMED"].includes(booking.status) || booking.startsAt <= now)
    return { canCancel: false, late: false, feePercent: 0 };
  if (booking.status === "PENDING_APPROVAL") return { canCancel: true, late: false, feePercent: 0 };
  const late = booking.startsAt.getTime() - now.getTime() < policy.lateCancelWindowHours * 3600000;
  return { canCancel: true, late, feePercent: late ? policy.lateCancelFeePercent : 0 };
}
