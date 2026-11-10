/**
 * End-to-end billing cycle against a real Postgres database:
 * booking rules → usage → month-end draft → auto-issue → reminders → late fee → suspension → payment → reinstatement.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database whose name ends in "_test".
 */
import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL ?? "";
const enabled = /_test(\?|$)/.test(url);

describe.skipIf(!enabled)("billing cycle (integration)", async () => {
  const { prisma } = await import("@/lib/db");
  const { createBooking, BookingError } = await import("@/lib/services/bookings");
  const { runAutomation, housekeeping } = await import("@/lib/services/jobs");
  const { recordPayment, buildStatement, generateInvoice } = await import("@/lib/services/invoicing");

  const HOUR = 3600000;
  let customerId = "";
  let memberId = "";
  let equipmentId = "";

  beforeAll(async () => {
    // Fresh schema in the disposable test database, then apply migrations.
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });

    await prisma.facilitySettings.create({
      data: { id: 1, timezone: "UTC", taxRatePercent: 10, autoIssueInvoices: true, paymentTermsDays: 30, lateFeePercent: 2, suspendAfterDaysOverdue: 45 },
    });
    const tier = await prisma.pricingTier.create({ data: { name: "Pro", level: 2, discountPercent: 10 } });
    const cat = await prisma.equipmentCategory.create({ data: { name: "Imaging" } });
    const customer = await prisma.customer.create({
      data: { name: "Acme Bio", billingEmail: "ap@acme.test", status: "ACTIVE", tierId: tier.id, monthlyOfficeRentCents: 100000 },
    });
    const member = await prisma.user.create({
      data: { email: "sci@acme.test", name: "Sci", role: "CUSTOMER_MEMBER", passwordHash: "x", customerId: customer.id },
    });
    const eq = await prisma.equipment.create({ data: { name: "Microscope", assetTag: "M1", categoryId: cat.id, hourlyRateCents: 10000, minTierLevel: 2 } });
    customerId = customer.id;
    memberId = member.id;
    equipmentId = eq.id;
  });

  it("enforces no double-booking even under concurrent requests", async () => {
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
    const req = () => createBooking({ userId: memberId, equipmentId, startsAt: start, endsAt: new Date(start.getTime() + 2 * HOUR) });
    const results = await Promise.allSettled([req(), req(), req()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BookingError);
    // Clean up so the future booking doesn't affect the October cycle below.
    await prisma.booking.deleteMany({});
  });

  it("runs the full month-end cycle", async () => {
    // October usage: one completed 2h session with a 10 minute overrun, one forgotten check-in.
    const s1 = new Date("2026-10-05T10:00:00Z");
    await prisma.booking.create({
      data: {
        customerId, userId: memberId, equipmentId, startsAt: s1, endsAt: new Date(s1.getTime() + 2 * HOUR), hourlyRateCents: 10000,
        status: "COMPLETED", checkedInAt: s1, checkedOutAt: new Date(s1.getTime() + 2 * HOUR + 10 * 60000),
      },
    });
    const s2 = new Date("2026-10-20T10:00:00Z");
    await prisma.booking.create({
      data: { customerId, userId: memberId, equipmentId, startsAt: s2, endsAt: new Date(s2.getTime() + HOUR), hourlyRateCents: 10000, status: "CHECKED_IN", checkedInAt: s2 },
    });

    const hk = await housekeeping(new Date("2026-10-31T00:00:00Z"));
    expect(hk.autoCheckedOut).toBe(1);

    const preview = await buildStatement(customerId, "2026-10");
    // 2h15m (2h10m rounded up to 15 min) + 1h auto-closed = 3.25h × $100 = $325, plus $1,000 rent
    expect(preview.subtotalCents).toBe(32500 + 100000);

    // Nov 1: automation generates the October draft. It has a warning (auto-closed session) so it is held for review.
    const r1 = await runAutomation(new Date("2026-11-01T06:00:00Z"));
    expect(r1.ok).toBe(true);
    let inv = await prisma.invoice.findFirstOrThrow({ where: { customerId, period: "2026-10" }, include: { lines: true } });
    expect(inv.status).toBe("DRAFT");
    expect(inv.warnings.length).toBeGreaterThan(0);
    expect(inv.discountCents).toBe(3250);
    expect(inv.totalCents).toBe(132500 - 3250 + Math.round((132500 - 3250) * 0.1));

    // Regenerating keeps the number and doesn't double count.
    const number = inv.number;
    const regen = await generateInvoice(customerId, "2026-10");
    expect(regen.status).toBe("regenerated");
    inv = await prisma.invoice.findFirstOrThrow({ where: { customerId, period: "2026-10", status: "DRAFT" }, include: { lines: true } });
    expect(inv.number).toBe(number);
    expect(inv.lines).toHaveLength(3);
    // The test simulates the calendar; align the draft's creation time with the simulated month-end run.
    await prisma.invoice.update({ where: { id: inv.id }, data: { createdAt: new Date("2026-11-01T06:00:00Z") } });

    // Not reviewed within 3 days -> issued automatically, with an email to the customer.
    await runAutomation(new Date("2026-11-05T06:00:00Z"));
    inv = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    expect(inv.status).toBe("ISSUED");
    expect(await prisma.emailLog.count({ where: { relatedId: inv.id, kind: "invoice.issued" } })).toBe(1);

    // Upcoming reminder, then overdue reminder + one-time late fee.
    const due = inv.dueAt!;
    await runAutomation(new Date(due.getTime() - 3 * 24 * HOUR));
    await runAutomation(new Date(due.getTime() + 2 * 24 * HOUR));
    inv = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    expect(inv.reminderCount).toBe(2);
    expect(inv.lateFeeApplied).toBe(true);
    const fee = await prisma.billingAdjustment.findFirstOrThrow({ where: { customerId, isLateFee: true } });
    expect(fee.amountCents).toBe(Math.round(inv.totalCents * 0.02));

    // 45+ days overdue -> suspended.
    await runAutomation(new Date(due.getTime() + 46 * 24 * HOUR));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).status).toBe("SUSPENDED");

    // Partial payment keeps suspension; full payment marks paid and reinstates automatically.
    await recordPayment({ invoiceId: inv.id, amountCents: 50000, method: "BANK_TRANSFER", receivedAt: new Date(), actorId: null });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).status).toBe("SUSPENDED");
    await recordPayment({ invoiceId: inv.id, amountCents: inv.totalCents - 50000, method: "BANK_TRANSFER", receivedAt: new Date(), actorId: null });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).status).toBe("ACTIVE");
  });
});
