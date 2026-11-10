import { Prisma, type PaymentMethod } from "@prisma/client";
import { prisma } from "../db";
import { getSettings, type Settings } from "../settings";
import { audit } from "../audit";
import { computeStatement, type Statement } from "../domain/billing";
import { applyPayment, balanceCents, dueDateFor } from "../domain/invoice-automation";
import { periodBounds } from "../domain/time";
import { fmt, fmtDate, money, periodLabel } from "../format";
import { sendEmail } from "./email";

const FINAL_STATUSES = ["COMPLETED", "NO_SHOW", "CANCELLED"] as const;
const OPEN_STATUSES = ["PENDING_APPROVAL", "CONFIRMED", "CHECKED_IN"] as const;

/**
 * Build the statement for a customer and period from live data.
 * Includes every finalized, not-yet-invoiced booking that started before the period ended
 * (so bookings closed late are picked up by the next invoice instead of being lost).
 */
export async function buildStatement(customerId: string, period: string, settings?: Settings): Promise<Statement & { bookingCount: number }> {
  const s = settings ?? (await getSettings());
  const { start, end } = periodBounds(period, s.timezone);
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, include: { tier: true } });
  const [finalBookings, openBookings, adjustments] = await Promise.all([
    prisma.booking.findMany({
      where: { customerId, invoiceLineId: null, status: { in: [...FINAL_STATUSES] }, startsAt: { lt: end } },
      include: { equipment: true, user: true },
    }),
    prisma.booking.findMany({
      where: { customerId, status: { in: [...OPEN_STATUSES] }, startsAt: { gte: start, lt: end } },
      include: { equipment: true, user: true },
    }),
    prisma.billingAdjustment.findMany({ where: { customerId, invoiceLineId: null, period: { lte: period } }, orderBy: { createdAt: "asc" } }),
  ]);
  const toBillable = (b: (typeof finalBookings)[number]) => ({
    id: b.id,
    equipmentName: b.equipment.name,
    userName: b.user.name,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    status: b.status,
    hourlyRateCents: b.hourlyRateCents,
    billingIncrementMinutes: b.equipment.billingIncrementMinutes,
    checkedInAt: b.checkedInAt,
    checkedOutAt: b.checkedOutAt,
    cancelledAt: b.cancelledAt,
    autoClosed: b.autoClosed,
    feeWaived: b.feeWaived,
  });
  const statement = computeStatement({
    policy: s,
    customer: {
      discountPercent: Number(customer.tier.discountPercent),
      monthlyOfficeRentCents: customer.status === "CLOSED" ? 0 : customer.monthlyOfficeRentCents,
      officeSuite: customer.officeSuite,
    },
    bookings: [...finalBookings, ...openBookings].map(toBillable),
    adjustments: adjustments.map((a) => ({ id: a.id, description: a.description, amountCents: a.amountCents, isLateFee: a.isLateFee })),
    periodLabel: periodLabel(period),
    formatWhen: (d) => fmt(d, s.timezone, "d MMM HH:mm"),
  });
  const autoClosed = finalBookings.filter((b) => b.autoClosed).length;
  if (autoClosed) statement.warnings.push(`${autoClosed} booking(s) were closed automatically (no check-out); please verify actual times.`);
  const earlier = finalBookings.filter((b) => b.startsAt < start).length;
  if (earlier) statement.warnings.push(`${earlier} booking(s) from earlier periods were closed late and are included here.`);
  return { ...statement, bookingCount: finalBookings.length };
}

async function nextInvoiceNumber(tx: Prisma.TransactionClient, period: string) {
  const prefix = `INV-${period.replace("-", "")}-`;
  const last = await tx.invoice.findFirst({ where: { number: { startsWith: prefix } }, orderBy: { number: "desc" } });
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

export type GenerateResult = { status: "created" | "regenerated" | "skipped"; invoiceId?: string; reason?: string };

/**
 * Create (or regenerate) the draft invoice for a customer/period. Issued, paid invoices are immutable;
 * if one exists for the period the call is skipped.
 */
export async function generateInvoice(customerId: string, period: string, actorId: string | null = null): Promise<GenerateResult> {
  const settings = await getSettings();
  const existing = await prisma.invoice.findFirst({ where: { customerId, period, status: { not: "VOID" } } });
  if (existing && existing.status !== "DRAFT") return { status: "skipped", invoiceId: existing.id, reason: `already ${existing.status.toLowerCase()}` };

  // Drop the old draft first: its lines cascade and linked bookings/adjustments are unlinked (SetNull),
  // so the fresh statement picks them up again. Safe to re-run if anything below fails.
  if (existing) await prisma.invoice.delete({ where: { id: existing.id } });
  const st = await buildStatement(customerId, period, settings);
  if (!st.lines.length) return { status: "skipped", reason: "nothing to bill" };

  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        number: existing?.number ?? (await nextInvoiceNumber(tx, period)),
        customerId,
        period,
        currency: settings.currency,
        subtotalCents: st.subtotalCents,
        discountCents: st.discountCents,
        taxCents: st.taxCents,
        totalCents: st.totalCents,
        warnings: st.warnings,
      },
    });
    for (const [i, l] of st.lines.entries()) {
      const line = await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unitCents: l.unitCents,
          amountCents: l.amountCents,
          discountable: l.discountable,
          sortOrder: i,
        },
      });
      if (l.bookingId) await tx.booking.update({ where: { id: l.bookingId }, data: { invoiceLineId: line.id } });
      if (l.adjustmentId) await tx.billingAdjustment.update({ where: { id: l.adjustmentId }, data: { invoiceLineId: line.id } });
    }
    await tx.auditLog.create({ data: { actorId, action: existing ? "invoice.regenerate" : "invoice.generate", entity: "Invoice", entityId: invoice.id } });
    return { status: existing ? ("regenerated" as const) : ("created" as const), invoiceId: invoice.id };
  }, { timeout: 30000 });
}

export async function generateAllForPeriod(period: string, actorId: string | null = null, opts: { onlyMissing?: boolean } = {}) {
  const customers = await prisma.customer.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] } }, select: { id: true } });
  const results: Record<string, number> = { created: 0, regenerated: 0, skipped: 0, failed: 0 };
  for (const c of customers) {
    if (opts.onlyMissing) {
      const has = await prisma.invoice.findFirst({ where: { customerId: c.id, period, status: { not: "VOID" } } });
      if (has) {
        results.skipped++;
        continue;
      }
    }
    try {
      const r = await generateInvoice(c.id, period, actorId);
      results[r.status]++;
    } catch (e) {
      results.failed++;
      console.error(`invoice generation failed for ${c.id}`, e);
    }
  }
  return results;
}

async function billingRecipients(customerId: string) {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    include: { users: { where: { role: "CUSTOMER_ADMIN", active: true } } },
  });
  return { customer, to: [customer.billingEmail, ...customer.users.map((u) => u.email)] };
}

export async function invoiceText(invoiceId: string) {
  const s = await getSettings();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { sortOrder: "asc" } }, customer: true } });
  const m = (c: number) => money(c, inv.currency);
  const lines = inv.lines.map((l) => `  ${l.description}\n      ${Number(l.quantity)} × ${m(l.unitCents)} = ${m(l.amountCents)}`).join("\n");
  return [
    `${s.facilityName} — Invoice ${inv.number}`,
    `Bill to: ${inv.customer.name}`,
    `Period: ${periodLabel(inv.period)}`,
    inv.issuedAt ? `Issued: ${fmtDate(inv.issuedAt, s.timezone)}   Due: ${fmtDate(inv.dueAt, s.timezone)}` : "",
    "",
    lines,
    "",
    `Subtotal: ${m(inv.subtotalCents)}`,
    inv.discountCents ? `Plan discount: -${m(inv.discountCents)}` : "",
    `Tax: ${m(inv.taxCents)}`,
    `Total: ${m(inv.totalCents)}`,
    inv.paidCents ? `Paid: ${m(inv.paidCents)}   Balance: ${m(balanceCents(inv))}` : "",
    "",
    `View online: ${process.env.APP_URL ?? ""}/portal/invoices/${inv.id}`,
    s.invoiceFooter,
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export async function issueInvoice(invoiceId: string, actorId: string | null, reason = "manual") {
  const settings = await getSettings();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { customer: true } });
  if (inv.status !== "DRAFT") throw new Error("Only draft invoices can be issued.");
  const issuedAt = new Date();
  const dueAt = dueDateFor(issuedAt, inv.customer.paymentTermsDays ?? settings.paymentTermsDays);
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "ISSUED", issuedAt, dueAt } });
  await audit(actorId, "invoice.issue", "Invoice", invoiceId, { reason });
  const { to } = await billingRecipients(inv.customerId);
  await sendEmail({
    to,
    subject: `Invoice ${inv.number} from ${settings.facilityName} — ${money(inv.totalCents, inv.currency)} due ${fmtDate(dueAt, settings.timezone)}`,
    body: await invoiceText(invoiceId),
    kind: "invoice.issued",
    relatedId: invoiceId,
  });
}

export async function voidInvoice(invoiceId: string, actorId: string, reason: string) {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
  if (inv.status === "PAID" || inv.paidCents > 0) throw new Error("Invoices with payments cannot be voided. Issue a credit adjustment instead.");
  if (inv.status === "VOID") return;
  const lineIds = inv.lines.map((l) => l.id);
  await prisma.$transaction([
    prisma.booking.updateMany({ where: { invoiceLineId: { in: lineIds } }, data: { invoiceLineId: null } }),
    prisma.billingAdjustment.updateMany({ where: { invoiceLineId: { in: lineIds } }, data: { invoiceLineId: null } }),
    prisma.invoice.update({ where: { id: invoiceId }, data: { status: "VOID", voidedAt: new Date(), notes: reason } }),
  ]);
  await audit(actorId, "invoice.void", "Invoice", invoiceId, { reason });
}

export async function recordPayment(input: {
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
  receivedAt: Date;
  actorId: string | null;
}) {
  const settings = await getSettings();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
  const r = applyPayment(inv, input.amountCents);
  await prisma.$transaction([
    prisma.payment.create({
      data: {
        invoiceId: inv.id,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference || null,
        receivedAt: input.receivedAt,
        recordedById: input.actorId,
      },
    }),
    prisma.invoice.update({
      where: { id: inv.id },
      data: { paidCents: r.paidCents, ...(r.fullyPaid ? { status: "PAID", paidAt: input.receivedAt } : {}) },
    }),
  ]);
  await audit(input.actorId, "invoice.payment", "Invoice", inv.id, { amountCents: input.amountCents, method: input.method });
  const { customer, to } = await billingRecipients(inv.customerId);
  await sendEmail({
    to,
    subject: `Payment received for ${inv.number} — thank you`,
    body: `We received ${money(input.amountCents, inv.currency)} on ${fmtDate(input.receivedAt, settings.timezone)} for invoice ${inv.number}.\n${
      r.fullyPaid ? "This invoice is now paid in full." : `Remaining balance: ${money(inv.totalCents - r.paidCents, inv.currency)}.`
    }`,
    kind: "invoice.payment",
    relatedId: inv.id,
  });
  if (r.fullyPaid) await maybeReinstate(customer.id, input.actorId);
  return r;
}

/** Lift an automatic overdue suspension once nothing is past due any more. */
export async function maybeReinstate(customerId: string, actorId: string | null) {
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (customer.status !== "SUSPENDED" || !customer.suspendedReason?.startsWith("AUTO:")) return false;
  const stillOverdue = await prisma.invoice.count({ where: { customerId, status: "ISSUED", dueAt: { lt: new Date() } } });
  if (stillOverdue) return false;
  await prisma.customer.update({ where: { id: customerId }, data: { status: "ACTIVE", suspendedReason: null } });
  await audit(actorId, "customer.reinstate", "Customer", customerId, { reason: "overdue invoices settled" });
  const { to } = await billingRecipients(customerId);
  await sendEmail({
    to,
    subject: "Your account has been reinstated",
    body: "Thank you for your payment. Your organisation can book equipment again.",
    kind: "customer.reinstated",
    relatedId: customerId,
  });
  return true;
}
