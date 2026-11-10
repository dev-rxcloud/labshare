import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { generateAllForPeriod, issueInvoice } from "@/lib/services/invoicing";
import { daysOverdue } from "@/lib/domain/invoice-automation";
import { periodOf, previousPeriod } from "@/lib/domain/time";
import { errMsg, flash, str } from "@/lib/actions";
import { fmtDate, money, periodLabel } from "@/lib/format";
import { Card, Empty, Flash, PageHeader, Stat, StatusBadge } from "@/components/ui";

async function generate(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const period = str(fd, "period");
  try {
    const r = await generateAllForPeriod(period, user.id);
    flash(`/admin/invoices?period=${period}`, "ok", `Drafts for ${periodLabel(period)}: ${r.created} created, ${r.regenerated} regenerated, ${r.skipped} skipped${r.failed ? `, ${r.failed} failed` : ""}.`);
  } catch (e) {
    flash(`/admin/invoices?period=${period}`, "error", errMsg(e));
  }
}

async function issueAll(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const period = str(fd, "period");
  const drafts = await prisma.invoice.findMany({ where: { status: "DRAFT", period, totalCents: { gt: 0 } } });
  for (const d of drafts) await issueInvoice(d.id, user.id, "bulk issue");
  flash(`/admin/invoices?period=${period}`, "ok", `Issued and emailed ${drafts.length} invoice(s).`);
}

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ period?: string; status?: string; ok?: string; error?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const now = new Date();
  const period = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : sp.status ? undefined : previousPeriod(periodOf(now, s.timezone));
  const where: Prisma.InvoiceWhereInput = {
    ...(period ? { period } : {}),
    ...(sp.status === "OVERDUE" ? { status: "ISSUED", dueAt: { lt: now } } : sp.status ? { status: sp.status as never } : {}),
  };
  const invoices = await prisma.invoice.findMany({ where, include: { customer: true }, orderBy: [{ period: "desc" }, { number: "asc" }] });
  const sum = (f: (i: (typeof invoices)[number]) => number) => invoices.filter((i) => i.status !== "VOID").reduce((t, i) => t + f(i), 0);
  const drafts = invoices.filter((i) => i.status === "DRAFT");

  return (
    <>
      <PageHeader
        title={period ? `Invoices · ${periodLabel(period)}` : `Invoices · ${sp.status?.toLowerCase()}`}
        actions={
          <>
            <form action="/admin/invoices" className="flex gap-2">
              <input className="input w-40" type="month" name="period" defaultValue={period} />
              <select className="input w-32" name="status" defaultValue={sp.status ?? ""}>
                <option value="">Any status</option><option>DRAFT</option><option>ISSUED</option><option value="OVERDUE">Overdue</option><option>PAID</option><option>VOID</option>
              </select>
              <button className="btn-secondary">Filter</button>
            </form>
          </>
        }
      />
      <Flash searchParams={sp} />
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Invoiced" value={money(sum((i) => i.totalCents), s.currency)} />
        <Stat label="Collected" value={money(sum((i) => i.paidCents), s.currency)} />
        <Stat label="Outstanding" value={money(sum((i) => (i.status === "DRAFT" ? 0 : i.totalCents - i.paidCents)), s.currency)} />
        <Stat label="Drafts awaiting review" value={drafts.length} />
      </div>
      {period && (
        <div className="mb-4 flex flex-wrap gap-2">
          <form action={generate}>
            <input type="hidden" name="period" value={period} />
            <button className="btn-secondary" title="Creates missing drafts and recalculates existing drafts. Issued invoices are never changed.">Generate / refresh drafts for {periodLabel(period)}</button>
          </form>
          {drafts.length > 0 && (
            <form action={issueAll}>
              <input type="hidden" name="period" value={period} />
              <button className="btn-primary">Issue & email all {drafts.length} drafts</button>
            </form>
          )}
        </div>
      )}
      <Card>
        {invoices.length === 0 ? <Empty>No invoices. Drafts are generated automatically on the 1st of each month, or use the button above.</Empty> : (
          <table className="table">
            <thead><tr><th>Number</th><th>Customer</th><th>Period</th><th>Issued</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th><th>Status</th></tr></thead>
            <tbody>
              {invoices.map((i) => {
                const od = i.status === "ISSUED" ? daysOverdue(i, now) : 0;
                return (
                  <tr key={i.id}>
                    <td><Link className="link font-mono" href={`/admin/invoices/${i.id}`}>{i.number}</Link>{i.warnings.length > 0 && i.status === "DRAFT" && <span className="ml-1 text-amber-600" title={i.warnings.join("\n")}>⚠</span>}</td>
                    <td>{i.customer.name}</td>
                    <td>{i.period}</td>
                    <td>{fmtDate(i.issuedAt, s.timezone)}</td>
                    <td className={od ? "text-red-700" : ""}>{fmtDate(i.dueAt, s.timezone)}{od > 0 && ` (+${od}d)`}</td>
                    <td className="text-right tabular-nums">{money(i.totalCents, i.currency)}</td>
                    <td className="text-right tabular-nums">{money(i.totalCents - i.paidCents, i.currency)}</td>
                    <td><StatusBadge status={od > 0 ? "OVERDUE" : i.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
