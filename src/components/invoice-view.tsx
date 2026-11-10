import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { fmtDate, money, periodLabel } from "@/lib/format";
import { StatusBadge } from "./ui";
import { daysOverdue } from "@/lib/domain/invoice-automation";

export async function loadInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: { customer: { include: { tier: true } }, lines: { orderBy: { sortOrder: "asc" } }, payments: { orderBy: { receivedAt: "asc" } } },
  });
}

export async function InvoiceView({ invoice }: { invoice: NonNullable<Awaited<ReturnType<typeof loadInvoice>>> }) {
  const s = await getSettings();
  const m = (c: number) => money(c, invoice.currency);
  const overdue = invoice.status === "ISSUED" ? daysOverdue(invoice, new Date()) : 0;
  return (
    <div className="card p-8">
      <div className="flex flex-wrap justify-between gap-6">
        <div>
          <div className="text-xl font-semibold text-brand-700">{s.facilityName}</div>
          <div className="text-sm text-slate-500">{s.billingEmail}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold">Invoice</div>
          <div className="font-mono text-sm">{invoice.number}</div>
          <div className="mt-1 flex justify-end gap-2">
            <StatusBadge status={invoice.status} />
            {overdue > 0 && <StatusBadge status="OVERDUE" />}
          </div>
        </div>
      </div>
      <div className="mt-6 grid gap-6 text-sm sm:grid-cols-3">
        <div>
          <div className="label">Bill to</div>
          <div className="font-medium">{invoice.customer.name}</div>
          {invoice.customer.billingAddress && <div className="whitespace-pre-line text-slate-600">{invoice.customer.billingAddress}</div>}
          <div className="text-slate-600">{invoice.customer.billingEmail}</div>
          {invoice.customer.taxId && <div className="text-slate-600">Tax ID: {invoice.customer.taxId}</div>}
        </div>
        <div>
          <div className="label">Billing period</div>
          <div>{periodLabel(invoice.period)}</div>
          <div className="mt-2 label">Plan</div>
          <div>{invoice.customer.tier.name}</div>
        </div>
        <div>
          <div className="label">Issued</div>
          <div>{fmtDate(invoice.issuedAt, s.timezone)}</div>
          <div className="mt-2 label">Due</div>
          <div className={overdue ? "font-medium text-red-700" : ""}>
            {fmtDate(invoice.dueAt, s.timezone)} {overdue > 0 && `(${overdue} days overdue)`}
          </div>
        </div>
      </div>
      <table className="table mt-8">
        <thead>
          <tr><th>Description</th><th className="text-right">Qty / hrs</th><th className="text-right">Rate</th><th className="text-right">Amount</th></tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="text-right tabular-nums">{Number(l.quantity)}</td>
              <td className="text-right tabular-nums">{m(l.unitCents)}</td>
              <td className="text-right tabular-nums">{m(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm">
        <Row label="Subtotal" value={m(invoice.subtotalCents)} />
        {invoice.discountCents > 0 && <Row label={`${invoice.customer.tier.name} plan discount`} value={`−${m(invoice.discountCents)}`} />}
        <Row label={`Tax (${s.taxRatePercent}%)`} value={m(invoice.taxCents)} />
        <Row label="Total" value={m(invoice.totalCents)} strong />
        {invoice.paidCents > 0 && (
          <>
            <Row label="Paid" value={`−${m(invoice.paidCents)}`} />
            <Row label="Balance due" value={m(invoice.totalCents - invoice.paidCents)} strong />
          </>
        )}
      </div>
      {invoice.payments.length > 0 && (
        <div className="mt-6 text-sm">
          <div className="label">Payments</div>
          <ul className="space-y-1">
            {invoice.payments.map((p) => (
              <li key={p.id}>
                {fmtDate(p.receivedAt, s.timezone)} — {m(p.amountCents)} by {p.method.replace("_", " ").toLowerCase()}
                {p.reference && <span className="text-slate-500"> (ref {p.reference})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-8 border-t border-slate-100 pt-4 text-xs text-slate-500">{s.invoiceFooter}</p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "border-t border-slate-200 pt-1 font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
