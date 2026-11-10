import { describe, expect, it } from "vitest";
import { billableMinutes, computeStatement, roundUpTo, type BillableBooking } from "@/lib/domain/billing";

const policy = { lateCancelWindowHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, taxRatePercent: 10 };
const customer = { discountPercent: 10, monthlyOfficeRentCents: 0, officeSuite: null };
const T = (s: string) => new Date(`2026-10-${s}Z`);

function booking(over: Partial<BillableBooking> = {}): BillableBooking {
  return {
    id: "b1",
    equipmentName: "Confocal",
    userName: "Ana",
    startsAt: T("05T10:00:00"),
    endsAt: T("05T12:00:00"),
    status: "COMPLETED",
    hourlyRateCents: 10000,
    billingIncrementMinutes: 15,
    checkedInAt: T("05T10:00:00"),
    checkedOutAt: T("05T11:00:00"),
    cancelledAt: null,
    ...over,
  };
}
const run = (bookings: BillableBooking[], extra: Partial<Parameters<typeof computeStatement>[0]> = {}) =>
  computeStatement({ policy, customer, bookings, adjustments: [], periodLabel: "2026-10", formatWhen: (d) => d.toISOString(), ...extra });

describe("billable minutes", () => {
  it("rounds up to the billing increment", () => {
    expect(roundUpTo(61, 15)).toBe(75);
    expect(roundUpTo(60, 15)).toBe(60);
    expect(roundUpTo(1, 1)).toBe(1);
  });
  it("bills at least the booked slot when used less", () => {
    expect(billableMinutes(booking()).minutes).toBe(120);
  });
  it("bills actual time on overrun, rounded up", () => {
    const r = billableMinutes(booking({ checkedOutAt: T("05T12:07:00") }));
    expect(r.minutes).toBe(135);
    expect(r.overrun).toBe(true);
  });
  it("falls back to booked time without check-in data", () => {
    expect(billableMinutes(booking({ checkedInAt: null, checkedOutAt: null })).minutes).toBe(120);
  });
});

describe("computeStatement", () => {
  it("bills completed usage with tier discount and tax", () => {
    const s = run([booking()]);
    expect(s.lines).toHaveLength(1);
    expect(s.subtotalCents).toBe(20000);
    expect(s.discountCents).toBe(2000);
    expect(s.taxCents).toBe(1800);
    expect(s.totalCents).toBe(19800);
    expect(s.billableHours).toBe(2);
  });

  it("charges no-shows at the no-show percentage", () => {
    const s = run([booking({ status: "NO_SHOW", checkedInAt: null, checkedOutAt: null })]);
    expect(s.lines[0].kind).toBe("NO_SHOW");
    expect(s.lines[0].amountCents).toBe(20000);
  });

  it("charges late cancellations only inside the window", () => {
    const late = run([booking({ status: "CANCELLED", cancelledAt: T("05T00:00:00") })]);
    expect(late.lines[0].kind).toBe("LATE_CANCELLATION");
    expect(late.lines[0].amountCents).toBe(10000);
    const early = run([booking({ status: "CANCELLED", cancelledAt: T("01T00:00:00") })]);
    expect(early.lines).toHaveLength(0);
  });

  it("never charges waived bookings", () => {
    expect(run([booking({ status: "NO_SHOW", feeWaived: true })]).lines).toHaveLength(0);
    expect(run([booking({ status: "CANCELLED", cancelledAt: T("05T11:00:00"), feeWaived: true })]).lines).toHaveLength(0);
  });

  it("does not bill rejected bookings and reports open ones", () => {
    const s = run([booking({ id: "r", status: "REJECTED" }), booking({ id: "o", status: "CONFIRMED" })]);
    expect(s.lines).toHaveLength(0);
    expect(s.openBookingIds).toEqual(["o"]);
    expect(s.warnings).toHaveLength(1);
  });

  it("adds office rent and adjustments without discounting them", () => {
    const s = run([booking()], {
      customer: { discountPercent: 10, monthlyOfficeRentCents: 150000, officeSuite: "Suite 4B" },
      adjustments: [{ id: "a", description: "Goodwill credit", amountCents: -5000, isLateFee: false }],
    });
    expect(s.lines.map((l) => l.kind)).toEqual(["EQUIPMENT_USAGE", "OFFICE_RENT", "ADJUSTMENT"]);
    expect(s.subtotalCents).toBe(20000 + 150000 - 5000);
    expect(s.discountCents).toBe(2000); // only on usage
    expect(s.taxCents).toBe(Math.round((165000 - 2000) * 0.1));
  });
});
