/**
 * Scheduled automation. `runAutomation()` is idempotent and safe to call as often as every few minutes;
 * production should call it at least hourly (see /api/cron/run, vercel.json and the GitHub Actions workflow).
 *
 *  1. Housekeeping       – no-shows, auto check-out of forgotten sessions, expire stale approval requests
 *  2. Month-end close    – after a month ends, generate a draft invoice for every customer
 *  3. Auto-issue         – issue drafts automatically (immediately, or after the review window)
 *  4. Dunning            – upcoming/overdue reminders, one-time late fee, auto-suspension of overdue accounts
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getSettings } from "../settings";
import { audit } from "../audit";
import { addMinutes, periodOf, previousPeriod } from "../domain/time";
import { daysOverdue, lateFeeCents, reminderDue, shouldAutoIssue, shouldSuspend } from "../domain/invoice-automation";
import { generateAllForPeriod, invoiceText, issueInvoice } from "./invoicing";
import { sendEmail } from "./email";
import { fmtDate, money } from "../format";

const AUTO_CHECKOUT_AFTER_MINUTES = 120;

export async function housekeeping(now = new Date()) {
  const s = await getSettings();
  const noShowCutoff = addMinutes(now, -s.noShowGraceMinutes);
  const noShows = await prisma.booking.updateMany({
    where: { status: "CONFIRMED", startsAt: { lt: noShowCutoff } },
    data: { status: "NO_SHOW" },
  });
  const forgotten = await prisma.booking.findMany({
    where: { status: "CHECKED_IN", endsAt: { lt: addMinutes(now, -AUTO_CHECKOUT_AFTER_MINUTES) } },
  });
  for (const b of forgotten) {
    // Bill the booked slot; staff can correct actual times from the usage review screen.
    await prisma.booking.update({ where: { id: b.id }, data: { status: "COMPLETED", checkedOutAt: b.endsAt, autoClosed: true } });
  }
  const expired = await prisma.booking.updateMany({
    where: { status: "PENDING_APPROVAL", startsAt: { lt: now } },
    data: { status: "REJECTED", cancelReason: "Approval request expired" },
  });
  return { noShows: noShows.count, autoCheckedOut: forgotten.length, approvalsExpired: expired.count };
}

export async function monthEndClose(now = new Date()) {
  const s = await getSettings();
  if (!s.autoGenerateInvoices) return { skipped: "auto-generation disabled" };
  const period = previousPeriod(periodOf(now, s.timezone));
  const results = await generateAllForPeriod(period, null, { onlyMissing: true });
  return { period, ...results };
}

export async function invoiceLifecycle(now = new Date()) {
  const s = await getSettings();
  const out = { issued: 0, reminders: 0, lateFees: 0, suspended: 0 };

  const drafts = await prisma.invoice.findMany({ where: { status: "DRAFT" } });
  for (const inv of drafts) {
    const d = shouldAutoIssue({ ...inv, hasWarnings: inv.warnings.length > 0 }, s, now);
    if (d.issue) {
      await issueInvoice(inv.id, null, `auto: ${d.reason}`);
      out.issued++;
    }
  }

  const open = await prisma.invoice.findMany({ where: { status: "ISSUED" }, include: { customer: true } });
  for (const inv of open) {
    const kind = reminderDue(inv, s, now);
    if (kind) {
      const admins = await prisma.user.findMany({ where: { customerId: inv.customerId, role: "CUSTOMER_ADMIN", active: true } });
      const balance = money(inv.totalCents - inv.paidCents, inv.currency);
      await sendEmail({
        to: [inv.customer.billingEmail, ...admins.map((a) => a.email)],
        subject:
          kind === "UPCOMING"
            ? `Reminder: invoice ${inv.number} (${balance}) is due ${fmtDate(inv.dueAt, s.timezone)}`
            : `OVERDUE: invoice ${inv.number} (${balance}) is ${daysOverdue(inv, now)} days past due`,
        body:
          (kind === "OVERDUE" && s.suspendAfterDaysOverdue > 0
            ? `Accounts more than ${s.suspendAfterDaysOverdue} days overdue are automatically suspended from booking.\n\n`
            : "") + (await invoiceText(inv.id)),
        kind: `invoice.reminder.${kind.toLowerCase()}`,
        relatedId: inv.id,
      });
      await prisma.invoice.update({ where: { id: inv.id }, data: { lastReminderAt: now, reminderCount: { increment: 1 } } });
      out.reminders++;
    }
    const fee = lateFeeCents(inv, s, now);
    if (fee > 0) {
      await prisma.$transaction([
        prisma.billingAdjustment.create({
          data: { customerId: inv.customerId, period: periodOf(now, s.timezone), description: `Late payment fee on ${inv.number} (${s.lateFeePercent}%)`, amountCents: fee, isLateFee: true },
        }),
        prisma.invoice.update({ where: { id: inv.id }, data: { lateFeeApplied: true } }),
      ]);
      out.lateFees++;
    }
  }

  // Auto-suspend customers with invoices beyond the overdue threshold.
  const byCustomer = new Map<string, typeof open>();
  for (const inv of open) byCustomer.set(inv.customerId, [...(byCustomer.get(inv.customerId) ?? []), inv]);
  for (const [customerId, invoices] of byCustomer) {
    const customer = invoices[0].customer;
    if (customer.status !== "ACTIVE" || !shouldSuspend(invoices, s, now)) continue;
    await prisma.customer.update({
      where: { id: customerId },
      data: { status: "SUSPENDED", suspendedReason: `AUTO: invoice(s) more than ${s.suspendAfterDaysOverdue} days overdue` },
    });
    await audit(null, "customer.auto_suspend", "Customer", customerId);
    await sendEmail({
      to: [customer.billingEmail],
      subject: "Account suspended due to overdue invoices",
      body: `Your organisation's booking access has been suspended because invoices are more than ${s.suspendAfterDaysOverdue} days overdue. Access is restored automatically once overdue invoices are paid.`,
      kind: "customer.suspended",
      relatedId: customerId,
    });
    out.suspended++;
  }
  return out;
}

export async function runAutomation(now = new Date()) {
  const run = await prisma.jobRun.create({ data: { job: "automation" } });
  const summary: Record<string, unknown> = {};
  let ok = true;
  for (const [name, step] of [
    ["housekeeping", housekeeping],
    ["monthEndClose", monthEndClose],
    ["invoiceLifecycle", invoiceLifecycle],
  ] as const) {
    try {
      summary[name] = await step(now);
    } catch (e) {
      ok = false;
      summary[name] = { error: (e as Error).message };
      console.error(`automation step ${name} failed`, e);
    }
  }
  await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok, summary: summary as Prisma.InputJsonValue } });
  return { ok, summary };
}
