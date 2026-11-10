/**
 * Pure billing engine: turns a customer's bookings and adjustments for a period into invoice lines.
 * The same function powers the live "usage review" screen and the persisted invoice, so what the
 * facility reviews is exactly what gets invoiced.
 */
import { minutesBetween } from "./time";

export interface BillingPolicy {
  lateCancelWindowHours: number;
  lateCancelFeePercent: number;
  noShowFeePercent: number;
  taxRatePercent: number;
}

export interface BillableBooking {
  id: string;
  equipmentName: string;
  userName: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  hourlyRateCents: number;
  billingIncrementMinutes: number;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  cancelledAt: Date | null;
  autoClosed?: boolean;
  feeWaived?: boolean;
}

export interface BillableAdjustment {
  id: string;
  description: string;
  amountCents: number;
  isLateFee: boolean;
}

export interface BillingCustomer {
  discountPercent: number;
  monthlyOfficeRentCents: number;
  officeSuite: string | null;
}

export type LineKind = "EQUIPMENT_USAGE" | "LATE_CANCELLATION" | "NO_SHOW" | "OFFICE_RENT" | "ADJUSTMENT" | "LATE_FEE";

export interface StatementLine {
  kind: LineKind;
  description: string;
  quantity: number; // hours for time-based lines, 1 otherwise
  unitCents: number;
  amountCents: number;
  discountable: boolean;
  bookingId?: string;
  adjustmentId?: string;
  flags?: string[];
}

export interface Statement {
  lines: StatementLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  billableHours: number;
  /** Bookings in the period that are not yet in a final state and therefore not billed. */
  openBookingIds: string[];
  warnings: string[];
}

export function roundUpTo(minutes: number, increment: number): number {
  if (increment <= 1) return Math.max(0, Math.ceil(minutes));
  return Math.max(0, Math.ceil(minutes / increment) * increment);
}

export function billableMinutes(b: BillableBooking): { minutes: number; actualMinutes: number | null; overrun: boolean } {
  const booked = minutesBetween(b.startsAt, b.endsAt);
  const actual = b.checkedInAt && b.checkedOutAt ? Math.max(0, minutesBetween(b.checkedInAt, b.checkedOutAt)) : null;
  const raw = Math.max(booked, actual ?? 0);
  return { minutes: roundUpTo(raw, b.billingIncrementMinutes), actualMinutes: actual, overrun: (actual ?? 0) > booked };
}

const cents = (n: number) => Math.round(n);
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

export function computeStatement(input: {
  policy: BillingPolicy;
  customer: BillingCustomer;
  bookings: BillableBooking[];
  adjustments: BillableAdjustment[];
  periodLabel: string;
  formatWhen: (d: Date) => string;
}): Statement {
  const { policy, customer } = input;
  const lines: StatementLine[] = [];
  const openBookingIds: string[] = [];
  const warnings: string[] = [];
  let billableHours = 0;

  const sorted = [...input.bookings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const b of sorted) {
    const when = input.formatWhen(b.startsAt);
    const bookedMinutes = minutesBetween(b.startsAt, b.endsAt);
    switch (b.status) {
      case "COMPLETED": {
        const { minutes, actualMinutes, overrun } = billableMinutes(b);
        const flags: string[] = [];
        if (overrun) flags.push("overrun");
        if (b.autoClosed) flags.push("auto-closed");
        if (actualMinutes == null) flags.push("no-check-in-data");
        billableHours += minutes / 60;
        lines.push({
          kind: "EQUIPMENT_USAGE",
          description: `${b.equipmentName} — ${when} (${b.userName})${overrun ? " · overrun" : ""}`,
          quantity: hours(minutes),
          unitCents: b.hourlyRateCents,
          amountCents: cents((b.hourlyRateCents * minutes) / 60),
          discountable: true,
          bookingId: b.id,
          flags,
        });
        break;
      }
      case "NO_SHOW": {
        if (policy.noShowFeePercent <= 0 || b.feeWaived) break;
        const amount = cents(((b.hourlyRateCents * bookedMinutes) / 60) * (policy.noShowFeePercent / 100));
        lines.push({
          kind: "NO_SHOW",
          description: `No-show: ${b.equipmentName} — ${when} (${b.userName}), ${policy.noShowFeePercent}% of booked time`,
          quantity: hours(bookedMinutes),
          unitCents: cents(b.hourlyRateCents * (policy.noShowFeePercent / 100)),
          amountCents: amount,
          discountable: true,
          bookingId: b.id,
        });
        break;
      }
      case "CANCELLED": {
        if (!b.cancelledAt || policy.lateCancelFeePercent <= 0 || b.feeWaived) break;
        const late = b.startsAt.getTime() - b.cancelledAt.getTime() < policy.lateCancelWindowHours * 3600000;
        if (!late) break;
        const amount = cents(((b.hourlyRateCents * bookedMinutes) / 60) * (policy.lateCancelFeePercent / 100));
        lines.push({
          kind: "LATE_CANCELLATION",
          description: `Late cancellation: ${b.equipmentName} — ${when} (${b.userName}), ${policy.lateCancelFeePercent}% of booked time`,
          quantity: hours(bookedMinutes),
          unitCents: cents(b.hourlyRateCents * (policy.lateCancelFeePercent / 100)),
          amountCents: amount,
          discountable: true,
          bookingId: b.id,
        });
        break;
      }
      case "PENDING_APPROVAL":
      case "CONFIRMED":
      case "CHECKED_IN":
        openBookingIds.push(b.id);
        break;
      default:
        break; // REJECTED etc. are never billed
    }
  }
  if (openBookingIds.length)
    warnings.push(`${openBookingIds.length} booking(s) in this period are still open and are not billed yet.`);

  if (customer.monthlyOfficeRentCents > 0) {
    lines.push({
      kind: "OFFICE_RENT",
      description: `Office rent${customer.officeSuite ? ` — ${customer.officeSuite}` : ""} (${input.periodLabel})`,
      quantity: 1,
      unitCents: customer.monthlyOfficeRentCents,
      amountCents: customer.monthlyOfficeRentCents,
      discountable: false,
    });
  }

  for (const a of input.adjustments) {
    lines.push({
      kind: a.isLateFee ? "LATE_FEE" : "ADJUSTMENT",
      description: a.description,
      quantity: 1,
      unitCents: a.amountCents,
      amountCents: a.amountCents,
      discountable: false,
      adjustmentId: a.id,
    });
  }

  return { ...totals(lines, customer.discountPercent, policy.taxRatePercent), lines, billableHours: Math.round(billableHours * 100) / 100, openBookingIds, warnings };
}

export function totals(lines: Pick<StatementLine, "amountCents" | "discountable">[], discountPercent: number, taxRatePercent: number) {
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const discountBase = lines.filter((l) => l.discountable).reduce((s, l) => s + l.amountCents, 0);
  const discountCents = cents(Math.max(0, discountBase) * (discountPercent / 100));
  const taxable = Math.max(0, subtotalCents - discountCents);
  const taxCents = cents(taxable * (taxRatePercent / 100));
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}
