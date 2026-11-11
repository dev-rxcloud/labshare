import Link from "next/link";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { buildStatement } from "@/lib/services/invoicing";
import { periodOf } from "@/lib/domain/time";
import { fmt, money, periodLabel } from "@/lib/format";
import { Card, Empty, PageHeader, Stat, StatusBadge } from "@/components/ui";

export default async function PortalHome() {
  const user = await requireCustomerUser();
  const s = await getSettings();
  const now = new Date();
  const period = periodOf(now, s.timezone);
  const isAdmin = user.role === "CUSTOMER_ADMIN";
  const [upcoming, statement, openInvoices] = await Promise.all([
    prisma.booking.findMany({
      where: { userId: user.id, endsAt: { gte: now }, status: { in: ["PENDING_APPROVAL", "CONFIRMED", "CHECKED_IN"] } },
      include: { equipment: true },
      orderBy: { startsAt: "asc" },
      take: 8,
    }),
    buildStatement(user.customer.id, period, s),
    isAdmin ? prisma.invoice.findMany({ where: { customerId: user.customer.id, status: "ISSUED" }, orderBy: { dueAt: "asc" } }) : Promise.resolve([]),
  ]);
  const outstanding = openInvoices.reduce((t, i) => t + i.totalCents - i.paidCents, 0);

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        subtitle={`${user.customer.name} · ${user.customer.tier.name} plan`}
        actions={<Link href="/portal/equipment" className="btn-primary">Book equipment</Link>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label={`Billable hours · ${periodLabel(period)}`} value={statement.billableHours} hint={user.customer.monthlyHourQuota ? `Quota ${user.customer.monthlyHourQuota} h/month` : undefined} />
        {isAdmin && <Stat label="Charges so far this month" value={money(statement.totalCents, s.currency)} hint="Estimate incl. rent and tax, before invoicing" />}
        {isAdmin && <Stat label="Outstanding invoices" value={money(outstanding, s.currency)} hint={`${openInvoices.length} open`} />}
      </div>
      <Card title="Your upcoming bookings" actions={<Link className="link text-sm" href="/portal/bookings">All bookings</Link>}>
        {upcoming.length === 0 ? (
          <Empty>No upcoming bookings. <Link className="link" href="/portal/equipment">Book something</Link>.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Equipment</th><th>When</th><th>Status</th></tr></thead>
            <tbody>
              {upcoming.map((b) => (
                <tr key={b.id}>
                  <td>{b.equipment.name}<div className="text-xs text-deep-blue">{b.equipment.location}</div></td>
                  <td>{fmt(b.startsAt, s.timezone, "EEE d MMM, HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")}</td>
                  <td><StatusBadge status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
