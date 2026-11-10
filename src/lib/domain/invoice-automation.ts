/**
 * Pure decision functions for the invoicing lifecycle automation. The scheduled job loads state,
 * asks these functions what to do, and performs the actions. Keeping decisions pure makes the
 * dunning schedule testable without a database or a clock.
 */
import { addDays } from "./time";

export interface AutomationPolicy {
  autoIssueInvoices: boolean;
  autoIssueAfterDays: number;
  paymentTermsDays: number;
  reminderDaysBeforeDue: number;
  reminderEveryDaysOverdue: number;
  suspendAfterDaysOverdue: number;
  lateFeePercent: number;
}

export interface InvoiceState {
  status: "DRAFT" | "ISSUED" | "PAID" | "VOID";
  createdAt: Date;
  issuedAt: Date | null;
  dueAt: Date | null;
  totalCents: number;
  paidCents: number;
  lastReminderAt: Date | null;
  reminderCount: number;
  lateFeeApplied: boolean;
  hasWarnings?: boolean;
}

const DAY = 86400000;

/** Should a draft be issued now? Drafts with warnings (e.g. open bookings) are held for a human unless overdue for review. */
export function shouldAutoIssue(inv: InvoiceState, policy: AutomationPolicy, now: Date): { issue: boolean; reason?: string } {
  if (inv.status !== "DRAFT") return { issue: false };
  if (inv.totalCents <= 0) return { issue: false };
  if (policy.autoIssueInvoices && !inv.hasWarnings) return { issue: true, reason: "auto-issue enabled" };
  if (policy.autoIssueAfterDays > 0 && now.getTime() - inv.createdAt.getTime() >= policy.autoIssueAfterDays * DAY)
    return { issue: true, reason: `draft not reviewed within ${policy.autoIssueAfterDays} days` };
  return { issue: false };
}

export function dueDateFor(issuedAt: Date, termsDays: number): Date {
  return addDays(issuedAt, termsDays);
}

export function balanceCents(inv: Pick<InvoiceState, "totalCents" | "paidCents">): number {
  return inv.totalCents - inv.paidCents;
}

export function daysOverdue(inv: Pick<InvoiceState, "dueAt">, now: Date): number {
  if (!inv.dueAt || now <= inv.dueAt) return 0;
  return Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY);
}

export type ReminderKind = "UPCOMING" | "OVERDUE";

/** Decide whether to send a payment reminder now. */
export function reminderDue(inv: InvoiceState, policy: AutomationPolicy, now: Date): ReminderKind | null {
  if (inv.status !== "ISSUED" || !inv.dueAt || balanceCents(inv) <= 0) return null;
  const last = inv.lastReminderAt?.getTime() ?? 0;
  if (now < inv.dueAt) {
    const msToDue = inv.dueAt.getTime() - now.getTime();
    const sentUpcoming = inv.lastReminderAt != null && inv.lastReminderAt.getTime() >= inv.dueAt.getTime() - policy.reminderDaysBeforeDue * DAY;
    if (policy.reminderDaysBeforeDue > 0 && msToDue <= policy.reminderDaysBeforeDue * DAY && !sentUpcoming) return "UPCOMING";
    return null;
  }
  if (policy.reminderEveryDaysOverdue <= 0) return null;
  // First overdue reminder the day after due, then every N days.
  if (last < inv.dueAt.getTime()) return daysOverdue(inv, now) >= 1 ? "OVERDUE" : null;
  return now.getTime() - last >= policy.reminderEveryDaysOverdue * DAY ? "OVERDUE" : null;
}

export function lateFeeCents(inv: InvoiceState, policy: AutomationPolicy, now: Date): number {
  if (inv.status !== "ISSUED" || inv.lateFeeApplied || policy.lateFeePercent <= 0) return 0;
  if (daysOverdue(inv, now) < 1) return 0;
  return Math.round(balanceCents(inv) * (policy.lateFeePercent / 100));
}

export function shouldSuspend(overdueInvoices: Pick<InvoiceState, "dueAt">[], policy: AutomationPolicy, now: Date): boolean {
  if (policy.suspendAfterDaysOverdue <= 0) return false;
  return overdueInvoices.some((i) => daysOverdue(i, now) >= policy.suspendAfterDaysOverdue);
}

/** Apply a payment to an invoice. */
export function applyPayment(inv: Pick<InvoiceState, "totalCents" | "paidCents" | "status">, amountCents: number) {
  if (inv.status !== "ISSUED") throw new Error("Payments can only be recorded against issued invoices.");
  if (amountCents <= 0) throw new Error("Payment amount must be positive.");
  const paidCents = inv.paidCents + amountCents;
  return { paidCents, fullyPaid: paidCents >= inv.totalCents, overpaidCents: Math.max(0, paidCents - inv.totalCents) };
}
