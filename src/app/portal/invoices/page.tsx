import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { daysOverdue } from "@/lib/domain/invoice-automation";
import { fmtDate, money, periodLabel } from "@/lib/format";
import { Card, Empty, PageHeader, StatusBadge } from "@/components/ui";

export default async function PortalInvoices() {
  const user = await requireCustomerUser();
  if (user.role !== "CUSTOMER_ADMIN") redirect("/portal");
  const s = await getSettings();
  const invoices = await prisma.invoice.findMany({
    where: { customerId: user.customer.id, status: { in: ["ISSUED", "PAID"] } },
    orderBy: { period: "desc" },
  });
  return (
    <>
      <PageHeader title="Invoices" subtitle={`Invoices are emailed to ${user.customer.billingEmail} and organisation admins.`} />
      <Card>
        {invoices.length === 0 ? <Empty>No invoices yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Number</th><th>Period</th><th>Issued</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th><th>Status</th></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link className="link font-mono" href={`/portal/invoices/${i.id}`}>{i.number}</Link></td>
                  <td>{periodLabel(i.period)}</td>
                  <td>{fmtDate(i.issuedAt, s.timezone)}</td>
                  <td>{fmtDate(i.dueAt, s.timezone)}</td>
                  <td className="text-right tabular-nums">{money(i.totalCents, i.currency)}</td>
                  <td className="text-right tabular-nums">{money(i.totalCents - i.paidCents, i.currency)}</td>
                  <td><StatusBadge status={i.status === "ISSUED" && daysOverdue(i, new Date()) > 0 ? "OVERDUE" : i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
