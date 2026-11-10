import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { buildStatement } from "@/lib/services/invoicing";
import { periodOf, previousPeriod } from "@/lib/domain/time";
import { money, periodLabel } from "@/lib/format";
import { Card, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { PeriodPicker } from "@/components/statement-table";

export default async function UsageReview({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const period = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : previousPeriod(periodOf(new Date(), s.timezone));
  const customers = await prisma.customer.findMany({ where: { status: { not: "CLOSED" } }, include: { tier: true }, orderBy: { name: "asc" } });
  const invoices = await prisma.invoice.findMany({ where: { period, status: { not: "VOID" } } });
  const rows = await Promise.all(
    customers.map(async (c) => {
      const invoice = invoices.find((i) => i.customerId === c.id);
      // Once an invoice is issued, its usage is locked; show the invoice. Otherwise show the live statement.
      const live = !invoice || invoice.status === "DRAFT" ? await buildStatement(c.id, period, s) : null;
      return { c, invoice, live };
    }),
  );
  const total = rows.reduce((t, r) => t + (r.live ? r.live.totalCents : r.invoice!.totalCents), 0);
  const hours = rows.reduce((t, r) => t + (r.live?.billableHours ?? 0), 0);
  const flagged = rows.filter((r) => r.live && r.live.warnings.length).length;

  return (
    <>
      <PageHeader title={`Usage review · ${periodLabel(period)}`} subtitle="Review each customer's usage before invoices go out. Figures for uninvoiced customers are live." actions={<PeriodPicker period={period} base="/admin/usage" />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Total billable" value={money(total, s.currency)} />
        <Stat label="Uninvoiced billable hours" value={Math.round(hours * 100) / 100} />
        <Stat label="Customers needing attention" value={flagged} hint="Open or auto-closed bookings" />
      </div>
      <Card>
        <table className="table">
          <thead><tr><th>Customer</th><th>Plan</th><th className="text-right">Hours</th><th className="text-right">Total</th><th>Invoice</th><th>Notes</th></tr></thead>
          <tbody>
            {rows.map(({ c, invoice, live }) => (
              <tr key={c.id}>
                <td><Link className="link" href={`/admin/usage/${c.id}?period=${period}`}>{c.name}</Link>{c.status !== "ACTIVE" && <span className="ml-2"><StatusBadge status={c.status} /></span>}</td>
                <td>{c.tier.name}</td>
                <td className="text-right tabular-nums">{live ? live.billableHours : "—"}</td>
                <td className="text-right tabular-nums">{money(live ? live.totalCents : invoice!.totalCents, s.currency)}</td>
                <td>{invoice ? <Link className="link" href={`/admin/invoices/${invoice.id}`}><StatusBadge status={invoice.status} /></Link> : <span className="text-xs text-slate-500">not generated</span>}</td>
                <td className="text-xs text-amber-700">{live?.warnings.join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
