/**
 * Read-only forecast of what the billing automation will do, and when.
 * "Due now" is exactly what the next run (or "Run now") will act on; "upcoming" lists dated future actions.
 * It uses the same pure decision functions as the jobs, so the forecast can't drift from the behaviour.
 */
import { prisma } from "../db";
import { getSettings, type Settings } from "../settings";
import { addDays, addMinutes, periodBounds, periodOf, previousPeriod } from "../domain/time";
import { daysOverdue, lateFeeCents, reminderDue, shouldAutoIssue } from "../domain/invoice-automation";
import { buildStatement } from "./invoicing";
import { periodLabel } from "../format";

export type PlanKind = "close" | "issue" | "reminder" | "late-fee" | "suspend" | "no-show" | "auto-checkout" | "approval-expiry";

export interface PlannedAction {
  at: Date;
  kind: PlanKind;
  title: string;
  detail?: string;
  href?: string;
  amountCents?: number;
}

const DAY = 86400000;
const AUTO_CHECKOUT_AFTER_MINUTES = 120;
const HORIZON_DAYS = 60;

export async function planAutomation(now = new Date(), settings?: Settings) {
  const s = settings ?? (await getSettings());
  const horizon = addDays(now, HORIZON_DAYS);
  const actions: PlannedAction[] = [];

  // ---- Booking housekeeping --------------------------------------------------------------------
  const [lateConfirmed, staleCheckIns, pending] = await Promise.all([
    prisma.booking.findMany({
      where: { status: "CONFIRMED", startsAt: { lt: addMinutes(now, 24 * 60) } },
      include: { equipment: true, customer: true },
      orderBy: { startsAt: "asc" },
    }),
    prisma.booking.findMany({
      where: { status: "CHECKED_IN" },
      include: { equipment: true, customer: true },
    }),
    prisma.booking.findMany({
      where: { status: "PENDING_APPROVAL", startsAt: { lt: horizon } },
      include: { equipment: true, customer: true },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  for (const b of lateConfirmed) {
    const at = addMinutes(b.startsAt, s.noShowGraceMinutes);
    actions.push({
      at,
      kind: "no-show",
      title: `Mark as no-show unless checked in: ${b.equipment.name}`,
      detail: `${b.customer.name} · charged ${s.noShowFeePercent}% of the booked slot`,
      href: `/admin/bookings?customerId=${b.customerId}`,
    });
  }
  for (const b of staleCheckIns) {
    actions.push({
      at: addMinutes(b.endsAt, AUTO_CHECKOUT_AFTER_MINUTES),
      kind: "auto-checkout",
      title: `Auto check-out if still open: ${b.equipment.name}`,
      detail: `${b.customer.name} · billed for the booked slot and flagged for review`,
      href: `/admin/bookings?customerId=${b.customerId}`,
    });
  }
  for (const b of pending) {
    actions.push({
      at: b.startsAt,
      kind: "approval-expiry",
      title: `Approval request expires: ${b.equipment.name}`,
      detail: `${b.customer.name} · approve or decline before it starts`,
      href: `/admin/bookings?status=PENDING_APPROVAL`,
    });
  }

  // ---- Month-end close -------------------------------------------------------------------------
  if (s.autoGenerateInvoices) {
    const current = periodOf(now, s.timezone);
    const previous = previousPeriod(current);
    const customers = await prisma.customer.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true, name: true } });
    const invoiced = new Set(
      (await prisma.invoice.findMany({ where: { period: previous, status: { not: "VOID" } }, select: { customerId: true } })).map((i) => i.customerId),
    );
    // Anything still missing for last month is due now.
    let missing = 0;
    let missingTotal = 0;
    for (const c of customers.filter((c) => !invoiced.has(c.id))) {
      const st = await buildStatement(c.id, previous, s);
      if (st.lines.length) {
        missing++;
        missingTotal += st.totalCents;
      }
    }
    if (missing)
      actions.push({ at: now, kind: "close", title: `Create ${periodLabel(previous)} draft invoices for ${missing} customer(s)`, amountCents: missingTotal, href: `/admin/usage?period=${previous}` });
    // Next close: the first moment of next month, with an estimate from live usage so far.
    let estimate = 0;
    let billable = 0;
    for (const c of customers) {
      const st = await buildStatement(c.id, current, s);
      if (st.lines.length) {
        billable++;
        estimate += st.totalCents;
      }
    }
    actions.push({
      at: periodBounds(current, s.timezone).end,
      kind: "close",
      title: `Create ${periodLabel(current)} draft invoices`,
      detail: `${billable} customer(s) with billable activity so far · estimate grows until month end`,
      amountCents: estimate,
      href: `/admin/usage?period=${current}`,
    });
  }

  // ---- Draft invoices: auto-issue ----------------------------------------------------------------
  const drafts = await prisma.invoice.findMany({ where: { status: "DRAFT" }, include: { customer: true } });
  for (const inv of drafts) {
    const state = { ...inv, hasWarnings: inv.warnings.length > 0 };
    let at: Date | null = null;
    let why = "";
    if (shouldAutoIssue(state, s, now).issue) {
      at = now;
      why = shouldAutoIssue(state, s, now).reason ?? "";
    } else if (inv.totalCents > 0 && s.autoIssueAfterDays > 0) {
      at = addDays(inv.createdAt, s.autoIssueAfterDays);
      why = `if not reviewed within ${s.autoIssueAfterDays} day(s)`;
    }
    if (at)
      actions.push({
        at,
        kind: "issue",
        title: `Issue and email ${inv.number} to ${inv.customer.name}`,
        detail: why + (inv.warnings.length ? ` · ${inv.warnings.length} item(s) to check first` : ""),
        amountCents: inv.totalCents,
        href: `/admin/invoices/${inv.id}`,
      });
  }

  // ---- Issued invoices: reminders, late fee, suspension -----------------------------------------
  const open = await prisma.invoice.findMany({ where: { status: "ISSUED" }, include: { customer: true } });
  const suspendAt = new Map<string, { at: Date; name: string }>();
  for (const inv of open) {
    if (!inv.dueAt) continue;
    const balance = inv.totalCents - inv.paidCents;
    const href = `/admin/invoices/${inv.id}`;
    const due = reminderDue(inv, s, now);
    if (due) {
      actions.push({ at: now, kind: "reminder", title: `${due === "UPCOMING" ? "Payment reminder" : "Overdue notice"} for ${inv.number}`, detail: inv.customer.name, amountCents: balance, href });
    } else {
      // Next reminder date, if any.
      let next: Date | null = null;
      if (now < inv.dueAt) {
        const upcoming = new Date(inv.dueAt.getTime() - s.reminderDaysBeforeDue * DAY);
        const sent = inv.lastReminderAt && inv.lastReminderAt >= upcoming;
        if (s.reminderDaysBeforeDue > 0 && !sent && upcoming > now) next = upcoming;
        else if (s.reminderEveryDaysOverdue > 0) next = new Date(inv.dueAt.getTime() + DAY);
      } else if (s.reminderEveryDaysOverdue > 0) {
        const last = inv.lastReminderAt && inv.lastReminderAt >= inv.dueAt ? inv.lastReminderAt : null;
        next = last ? new Date(last.getTime() + s.reminderEveryDaysOverdue * DAY) : new Date(inv.dueAt.getTime() + DAY);
      }
      if (next && next < horizon)
        actions.push({
          at: next,
          kind: "reminder",
          title: `${next < inv.dueAt ? "Payment reminder" : "Overdue notice"} for ${inv.number}`,
          detail: `${inv.customer.name} · if still unpaid`,
          amountCents: balance,
          href,
        });
    }
    if (s.lateFeePercent > 0 && !inv.lateFeeApplied) {
      const feeNow = lateFeeCents(inv, s, now);
      const at = feeNow > 0 ? now : new Date(inv.dueAt.getTime() + DAY);
      if (at < horizon)
        actions.push({
          at,
          kind: "late-fee",
          title: `Add ${s.lateFeePercent}% late fee for ${inv.number}`,
          detail: `${inv.customer.name} · added to the next invoice if still unpaid`,
          amountCents: Math.round(balance * (s.lateFeePercent / 100)),
          href,
        });
    }
    if (s.suspendAfterDaysOverdue > 0 && inv.customer.status === "ACTIVE") {
      const at = new Date(inv.dueAt.getTime() + s.suspendAfterDaysOverdue * DAY);
      const cur = suspendAt.get(inv.customerId);
      if (!cur || at < cur.at) suspendAt.set(inv.customerId, { at, name: inv.customer.name });
    }
  }
  for (const [customerId, { at, name }] of suspendAt) {
    if (at >= horizon) continue;
    actions.push({
      at: at < now ? now : at,
      kind: "suspend",
      title: `Suspend booking access for ${name}`,
      detail: `if invoices are still ${s.suspendAfterDaysOverdue}+ days overdue · restored automatically on payment`,
      href: `/admin/customers/${customerId}`,
    });
  }

  actions.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    dueNow: actions.filter((a) => a.at <= now),
    upcoming: actions.filter((a) => a.at > now && a.at < horizon),
    overdueInvoices: open.filter((i) => daysOverdue(i, now) > 0).length,
  };
}

/** One plain-English sentence for a run summary. */
export function summarizeRun(summary: unknown): string {
  const s = (summary ?? {}) as Record<string, Record<string, unknown>>;
  const parts: string[] = [];
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const say = (count: number, one: string, many = `${one}s`) => count && parts.push(`${count} ${count === 1 ? one : many}`);
  const hk = s.housekeeping ?? {};
  say(n(hk.noShows), "no-show recorded", "no-shows recorded");
  say(n(hk.autoCheckedOut), "session auto-closed", "sessions auto-closed");
  say(n(hk.approvalsExpired), "approval request expired", "approval requests expired");
  const close = s.monthEndClose ?? {};
  say(n(close.created), "draft invoice created", "draft invoices created");
  const life = s.invoiceLifecycle ?? {};
  say(n(life.issued), "invoice issued", "invoices issued");
  say(n(life.reminders), "reminder sent", "reminders sent");
  say(n(life.lateFees), "late fee added", "late fees added");
  say(n(life.suspended), "account suspended", "accounts suspended");
  const errors = Object.entries(s).filter(([, v]) => v && typeof v === "object" && "error" in v).map(([k]) => k);
  if (errors.length) parts.push(`errors in ${errors.join(", ")}`);
  return parts.length ? parts.join(" · ") : "Nothing was due";
}

export function isQuietRun(summary: unknown) {
  return summarizeRun(summary) === "Nothing was due";
}
