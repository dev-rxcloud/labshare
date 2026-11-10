import { describe, expect, it } from "vitest";
import { cancellationTerms, checkAccess, validateBooking, type BookingRequestContext } from "@/lib/domain/booking-rules";

const now = new Date("2026-11-10T12:00:00Z");
function ctx(over: Partial<BookingRequestContext> = {}): BookingRequestContext {
  return {
    user: { id: "u", active: true, role: "CUSTOMER_MEMBER", customerId: "c" },
    customer: { id: "c", status: "ACTIVE", tierLevel: 1, monthlyHourQuota: null },
    equipment: {
      id: "e", status: "ACTIVE", minTierLevel: 1, restricted: false, requiresCertification: false,
      minBookingMinutes: 30, maxBookingMinutes: 240, bufferMinutes: 15, bookableFromHour: 0, bookableToHour: 24,
    },
    hasGrant: false,
    certification: null,
    now,
    startsAt: new Date("2026-11-11T14:00:00Z"),
    endsAt: new Date("2026-11-11T16:00:00Z"),
    timezone: "UTC",
    slotMinutes: 15,
    maxAdvanceDays: 60,
    existing: [],
    maintenance: [],
    customerHoursInPeriod: 0,
    ...over,
  };
}
const codes = (c: BookingRequestContext) => validateBooking(c).map((e) => e.code);

describe("access control", () => {
  it("allows a valid member", () => expect(checkAccess(ctx()).allowed).toBe(true));
  it("blocks suspended customers", () =>
    expect(codes(ctx({ customer: { id: "c", status: "SUSPENDED", tierLevel: 1, monthlyHourQuota: null } }))).toEqual(["CUSTOMER_NOT_ACTIVE"]));
  it("blocks facility staff from booking as a customer", () =>
    expect(codes(ctx({ user: { id: "u", active: true, role: "FACILITY_ADMIN", customerId: null } }))).toEqual(["USER_NOT_CUSTOMER"]));
  it("enforces tier level unless granted", () => {
    const eq = { ...ctx().equipment, minTierLevel: 2 };
    expect(codes(ctx({ equipment: eq }))).toEqual(["TIER_TOO_LOW"]);
    expect(codes(ctx({ equipment: eq, hasGrant: true }))).toEqual([]);
  });
  it("requires a grant for restricted equipment", () =>
    expect(codes(ctx({ equipment: { ...ctx().equipment, restricted: true } }))).toEqual(["RESTRICTED_NO_GRANT"]));
  it("requires a valid certification", () => {
    const eq = { ...ctx().equipment, requiresCertification: true };
    expect(codes(ctx({ equipment: eq }))).toEqual(["CERTIFICATION_REQUIRED"]);
    expect(codes(ctx({ equipment: eq, certification: { expiresAt: new Date("2026-01-01") } }))).toEqual(["CERTIFICATION_EXPIRED"]);
    expect(codes(ctx({ equipment: eq, certification: { expiresAt: null } }))).toEqual([]);
  });
});

describe("scheduling rules", () => {
  it("rejects past, misaligned, too short and too long bookings", () => {
    expect(codes(ctx({ startsAt: new Date("2026-11-09T10:00:00Z"), endsAt: new Date("2026-11-09T11:00:00Z") }))).toContain("IN_PAST");
    expect(codes(ctx({ startsAt: new Date("2026-11-11T14:05:00Z") }))).toContain("NOT_ON_SLOT");
    expect(codes(ctx({ endsAt: new Date("2026-11-11T14:15:00Z") }))).toContain("TOO_SHORT");
    expect(codes(ctx({ endsAt: new Date("2026-11-11T19:00:00Z") }))).toContain("TOO_LONG");
  });
  it("rejects bookings too far ahead", () =>
    expect(codes(ctx({ startsAt: new Date("2027-02-11T14:00:00Z"), endsAt: new Date("2027-02-11T15:00:00Z") }))).toContain("TOO_FAR_AHEAD"));
  it("detects conflicts including cleanup buffer", () => {
    const existing = [{ startsAt: new Date("2026-11-11T16:00:00Z"), endsAt: new Date("2026-11-11T17:00:00Z") }];
    expect(codes(ctx({ existing }))).toContain("CONFLICT"); // ends exactly at 16:00, buffer 15 min
    expect(codes(ctx({ existing, endsAt: new Date("2026-11-11T15:45:00Z") }))).toEqual([]);
  });
  it("respects maintenance windows", () =>
    expect(codes(ctx({ maintenance: [{ startsAt: new Date("2026-11-11T15:00:00Z"), endsAt: new Date("2026-11-11T18:00:00Z") }] }))).toContain("MAINTENANCE"));
  it("enforces bookable hours in the facility time zone", () => {
    const eq = { ...ctx().equipment, bookableFromHour: 8, bookableToHour: 18 };
    // 14:00Z = 09:00 in New York (EST) -> ok; 22:00Z = 17:00 -> 23:00Z ends 18:00 ok; 23:30Z ends 18:30 -> not ok
    expect(codes(ctx({ equipment: eq, timezone: "America/New_York" }))).toEqual([]);
    expect(
      codes(ctx({ equipment: eq, timezone: "America/New_York", startsAt: new Date("2026-11-11T22:00:00Z"), endsAt: new Date("2026-11-11T23:30:00Z") })),
    ).toContain("OUTSIDE_BOOKABLE_HOURS");
  });
  it("enforces monthly hour quotas", () =>
    expect(codes(ctx({ customer: { id: "c", status: "ACTIVE", tierLevel: 1, monthlyHourQuota: 10 }, customerHoursInPeriod: 9 }))).toContain("QUOTA_EXCEEDED"));
});

describe("cancellation terms", () => {
  const policy = { lateCancelWindowHours: 24, lateCancelFeePercent: 50 };
  it("is free outside the window and charged inside", () => {
    expect(cancellationTerms({ startsAt: new Date("2026-11-12T13:00:00Z"), status: "CONFIRMED" }, now, policy)).toEqual({ canCancel: true, late: false, feePercent: 0 });
    expect(cancellationTerms({ startsAt: new Date("2026-11-11T11:00:00Z"), status: "CONFIRMED" }, now, policy)).toEqual({ canCancel: true, late: true, feePercent: 50 });
  });
  it("cannot cancel started or completed bookings", () =>
    expect(cancellationTerms({ startsAt: new Date("2026-11-10T11:00:00Z"), status: "CONFIRMED" }, now, policy).canCancel).toBe(false));
});
