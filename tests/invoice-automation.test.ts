import { describe, expect, it } from "vitest";
import { applyPayment, daysOverdue, lateFeeCents, reminderDue, shouldAutoIssue, shouldSuspend, type InvoiceState } from "@/lib/domain/invoice-automation";
import { periodBounds, periodOf, previousPeriod } from "@/lib/domain/time";

const policy = {
  autoIssueInvoices: false, autoIssueAfterDays: 3, paymentTermsDays: 30, reminderDaysBeforeDue: 7,
  reminderEveryDaysOverdue: 7, suspendAfterDaysOverdue: 45, lateFeePercent: 2,
};
const d = (s: string) => new Date(`${s}T09:00:00Z`);
const inv = (over: Partial<InvoiceState> = {}): InvoiceState => ({
  status: "ISSUED", createdAt: d("2026-11-01"), issuedAt: d("2026-11-01"), dueAt: d("2026-12-01"),
  totalCents: 10000, paidCents: 0, lastReminderAt: null, reminderCount: 0, lateFeeApplied: false, ...over,
});

describe("auto-issue", () => {
  it("issues immediately when enabled and clean", () =>
    expect(shouldAutoIssue(inv({ status: "DRAFT" }), { ...policy, autoIssueInvoices: true }, d("2026-11-01")).issue).toBe(true));
  it("holds drafts with warnings until the review deadline", () => {
    const draft = inv({ status: "DRAFT", hasWarnings: true });
    expect(shouldAutoIssue(draft, { ...policy, autoIssueInvoices: true }, d("2026-11-02")).issue).toBe(false);
    expect(shouldAutoIssue(draft, policy, d("2026-11-04")).issue).toBe(true);
  });
  it("never issues zero-value drafts", () =>
    expect(shouldAutoIssue(inv({ status: "DRAFT", totalCents: 0 }), { ...policy, autoIssueInvoices: true }, d("2026-11-09")).issue).toBe(false));
});

describe("reminders", () => {
  it("sends one upcoming reminder within the window", () => {
    expect(reminderDue(inv(), policy, d("2026-11-20"))).toBeNull();
    expect(reminderDue(inv(), policy, d("2026-11-25"))).toBe("UPCOMING");
    expect(reminderDue(inv({ lastReminderAt: d("2026-11-25") }), policy, d("2026-11-27"))).toBeNull();
  });
  it("sends overdue reminders every N days", () => {
    expect(reminderDue(inv({ lastReminderAt: d("2026-11-25") }), policy, d("2026-12-02"))).toBe("OVERDUE");
    expect(reminderDue(inv({ lastReminderAt: d("2026-12-02") }), policy, d("2026-12-05"))).toBeNull();
    expect(reminderDue(inv({ lastReminderAt: d("2026-12-02") }), policy, d("2026-12-09"))).toBe("OVERDUE");
  });
  it("stops once paid", () => expect(reminderDue(inv({ paidCents: 10000 }), policy, d("2026-12-09"))).toBeNull());
});

describe("late fees and suspension", () => {
  it("charges a one-time late fee on the outstanding balance", () => {
    expect(lateFeeCents(inv({ paidCents: 5000 }), policy, d("2026-12-03"))).toBe(100);
    expect(lateFeeCents(inv({ lateFeeApplied: true }), policy, d("2026-12-03"))).toBe(0);
  });
  it("suspends after the threshold", () => {
    expect(daysOverdue(inv(), d("2027-01-15"))).toBe(45);
    expect(shouldSuspend([inv()], policy, d("2027-01-14"))).toBe(false);
    expect(shouldSuspend([inv()], policy, d("2027-01-15"))).toBe(true);
  });
  it("applies partial and full payments", () => {
    expect(applyPayment(inv(), 4000)).toEqual({ paidCents: 4000, fullyPaid: false, overpaidCents: 0 });
    expect(applyPayment(inv({ paidCents: 4000 }), 6000).fullyPaid).toBe(true);
    expect(() => applyPayment(inv({ status: "DRAFT" }), 100)).toThrow();
  });
});

describe("periods", () => {
  it("computes local month bounds", () => {
    const { start, end } = periodBounds("2026-11", "America/New_York");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(periodOf(new Date("2026-12-01T03:00:00Z"), "America/New_York")).toBe("2026-11");
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });
});
