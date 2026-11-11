import { CalendarDays, Hourglass, ReceiptText, Wallet } from "lucide-react";
import Link from "next/link";
import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { minutesBetween, periodBounds, periodOf } from "@/lib/domain/time";
import { fmt, money, periodLabel } from "@/lib/format";
import { Card, Empty, PageHeader, Stat, StatusBadge } from "@/components/ui";

export default async function AdminHome() {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const now = new Date();
  const period = periodOf(now, s.timezone);
  const { start, end } = periodBounds(period, s.timezone);
  const [pending, monthBookings, equipmentCount, overdue, drafts, lastRun, today] = await Promise.all([
    prisma.booking.findMany({ where: { status: "PENDING_APPROVAL" }, include: { equipment: true, customer: true, user: true }, orderBy: { startsAt: "asc" }, take: 10 }),
    prisma.booking.findMany({ where: { startsAt: { gte: start, lt: end }, status: { in: ["COMPLETED", "CHECKED_IN", "CONFIRMED"] } }, select: { startsAt: true, endsAt: true, hourlyRateCents: true, status: true } }),
    prisma.equipment.count({ where: { status: "ACTIVE" } }),
    prisma.invoice.findMany({ where: { status: "ISSUED", dueAt: { lt: now } }, include: { customer: true } }),
    prisma.invoice.count({ where: { status: "DRAFT" } }),
    prisma.jobRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.booking.findMany({
      where: { startsAt: { lt: new Date(now.getTime() + 86400000) }, endsAt: { gt: now }, status: { in: ["CONFIRMED", "CHECKED_IN"] } },
      include: { equipment: true, customer: true, user: true },
      orderBy: { startsAt: "asc" },
      take: 15,
    }),
  ]);
  const bookedHours = monthBookings.reduce((h, b) => h + minutesBetween(b.startsAt, b.endsAt) / 60, 0);
  const capacityHours = equipmentCount * ((end.getTime() - start.getTime()) / 3600000);
  const revenue = monthBookings.filter((b) => b.status === "COMPLETED").reduce((c, b) => c + (b.hourlyRateCents * minutesBetween(b.startsAt, b.endsAt)) / 60, 0);
  const overdueTotal = overdue.reduce((t, i) => t + i.totalCents - i.paidCents, 0);
  const isAdmin = user.role === "FACILITY_ADMIN";

  return (
    <>
      <PageHeader title="Overview" subtitle={periodLabel(period)} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<CalendarDays size={20} aria-hidden />} label="Booked hours this month" value={Math.round(bookedHours)} hint={`${capacityHours ? ((bookedHours / capacityHours) * 100).toFixed(1) : 0}% of 24/7 capacity across ${equipmentCount} instruments`} />
        {isAdmin && <Stat icon={<Wallet size={20} aria-hidden />} label="Completed usage (list price)" value={money(Math.round(revenue), s.currency)} hint="Before discounts, rent and tax" />}
        <Stat icon={<Hourglass size={20} aria-hidden />} label="Pending approvals" value={pending.length} />
        {isAdmin && <Stat icon={<ReceiptText size={20} aria-hidden />} label="Overdue receivables" value={money(overdueTotal, s.currency)} hint={`${overdue.length} invoice(s) · ${drafts} draft(s) awaiting review`} />}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Awaiting approval" actions={<Link href="/admin/bookings?status=PENDING_APPROVAL" className="link text-sm">Review</Link>}>
          {pending.length === 0 ? <Empty>Nothing to approve.</Empty> : (
            <ul className="divide-y divide-secondary-grey text-sm">
              {pending.map((b) => (
                <li key={b.id} className="py-2"><span className="font-medium">{b.equipment.name}</span> · {b.customer.name} ({b.user.name})<div className="text-xs text-deep-blue">{fmt(b.startsAt, s.timezone)}–{fmt(b.endsAt, s.timezone, "HH:mm")}</div></li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Next 24 hours">
          {today.length === 0 ? <Empty>No sessions scheduled.</Empty> : (
            <ul className="divide-y divide-secondary-grey text-sm">
              {today.map((b) => (
                <li key={b.id} className="flex items-center justify-between py-2">
                  <div><span className="font-medium">{b.equipment.name}</span> · {b.customer.name}<div className="text-xs text-deep-blue">{fmt(b.startsAt, s.timezone, "EEE HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")} · {b.user.name}</div></div>
                  <StatusBadge status={b.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        {isAdmin && (
          <Card title="Overdue invoices" actions={<Link href="/admin/invoices?status=OVERDUE" className="link text-sm">All</Link>}>
            {overdue.length === 0 ? <Empty>Nothing overdue.</Empty> : (
              <ul className="divide-y divide-secondary-grey text-sm">
                {overdue.map((i) => (
                  <li key={i.id} className="flex justify-between py-2"><Link className="link" href={`/admin/invoices/${i.id}`}>{i.number} · {i.customer.name}</Link><span className="tabular-nums">{money(i.totalCents - i.paidCents, i.currency)}</span></li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {isAdmin && (
          <Card title="Automation" actions={<Link href="/admin/automation" className="link text-sm">Details</Link>}>
            <p className="text-sm text-deep-blue">
              {lastRun ? <>Last run {fmt(lastRun.startedAt, s.timezone)} — {lastRun.ok ? "succeeded" : lastRun.ok === false ? "had errors" : "running"}.</> : "Automation has not run yet. Schedule /api/cron/run hourly."}
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
