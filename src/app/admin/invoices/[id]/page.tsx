import Link from "next/link";
import { notFound } from "next/navigation";
import type { PaymentMethod } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { generateInvoice, issueInvoice, recordPayment, voidInvoice } from "@/lib/services/invoicing";
import { localDateString, fromLocal } from "@/lib/domain/time";
import { centsField, errMsg, flash, str } from "@/lib/actions";
import { fmt } from "@/lib/format";
import { InvoiceView, loadInvoice } from "@/components/invoice-view";
import { PrintButton } from "@/components/print-button";
import { Card, Flash, PageHeader } from "@/components/ui";

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const id = str(fd, "rid");
  const back = `/admin/invoices/${id}`;
  const action = str(fd, "op");
  try {
    if (action === "issue") {
      await issueInvoice(id, user.id);
      flash(back, "ok", "Invoice issued and emailed to the customer.");
    }
    if (action === "regenerate") {
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      const r = await generateInvoice(inv.customerId, inv.period, user.id);
      if (!r.invoiceId) flash(`/admin/invoices?period=${inv.period}`, "ok", `Draft removed: ${r.reason}.`);
      flash(`/admin/invoices/${r.invoiceId}`, "ok", "Draft recalculated from current usage.");
    }
    if (action === "void") {
      await voidInvoice(id, user.id, str(fd, "reason") || "Voided by admin");
      flash(back, "ok", "Invoice voided. Its usage is unbilled again and will be picked up by the next generated invoice.");
    }
    if (action === "payment") {
      const s = await getSettings();
      const r = await recordPayment({
        invoiceId: id,
        amountCents: centsField(fd, "amount"),
        method: str(fd, "method") as PaymentMethod,
        reference: str(fd, "reference"),
        receivedAt: fromLocal(str(fd, "receivedAt"), "12:00", s.timezone),
        actorId: user.id,
      });
      flash(back, "ok", r.fullyPaid ? "Payment recorded — invoice paid in full. Receipt emailed." : "Partial payment recorded. Receipt emailed.");
    }
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function AdminInvoice({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const invoice = await loadInvoice((await params).id);
  if (!invoice) notFound();
  const [emails, history] = await Promise.all([
    prisma.emailLog.findMany({ where: { relatedId: invoice.id }, orderBy: { sentAt: "desc" } }),
    prisma.auditLog.findMany({ where: { entity: "Invoice", entityId: invoice.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const balance = invoice.totalCents - invoice.paidCents;
  return (
    <>
      <PageHeader
        title={`Invoice ${invoice.number}`}
        subtitle={invoice.customer.name}
        actions={<><Link href={`/admin/invoices?period=${invoice.period}`} className="btn-secondary">Back</Link><Link href={`/admin/usage/${invoice.customerId}?period=${invoice.period}`} className="btn-secondary">Usage detail</Link><PrintButton /></>}
      />
      <Flash searchParams={sp} />
      {invoice.status === "DRAFT" && invoice.warnings.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {invoice.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2"><InvoiceView invoice={invoice} /></div>
        <div className="no-print space-y-6">
          {invoice.status === "DRAFT" && (
            <Card title="Review draft">
              <p className="mb-3 text-sm text-slate-600">Check the lines, correct usage or add adjustments on the customer page, then recalculate. Issuing emails the invoice and starts the payment clock.</p>
              <div className="flex flex-wrap gap-2">
                <form action={act}><input type="hidden" name="rid" value={invoice.id} /><button name="op" value="issue" className="btn-primary">Issue & email</button></form>
                <form action={act}><input type="hidden" name="rid" value={invoice.id} /><button name="op" value="regenerate" className="btn-secondary">Recalculate</button></form>
              </div>
            </Card>
          )}
          {invoice.status === "ISSUED" && (
            <Card title="Record a payment">
              <form action={act} className="space-y-3">
                <input type="hidden" name="rid" value={invoice.id} />
                <input type="hidden" name="op" value="payment" />
                <div><label className="label">Amount</label><input className="input" name="amount" defaultValue={(balance / 100).toFixed(2)} required /></div>
                <div><label className="label">Received on</label><input className="input" type="date" name="receivedAt" defaultValue={localDateString(new Date(), s.timezone)} required /></div>
                <div>
                  <label className="label">Method</label>
                  <select className="input" name="method"><option value="BANK_TRANSFER">Bank transfer</option><option value="CHEQUE">Cheque</option><option value="CARD">Card</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select>
                </div>
                <div><label className="label">Reference</label><input className="input" name="reference" placeholder="Bank ref / cheque no." /></div>
                <button className="btn-primary w-full">Record payment</button>
              </form>
            </Card>
          )}
          {(invoice.status === "DRAFT" || (invoice.status === "ISSUED" && invoice.paidCents === 0)) && (
            <Card title="Void">
              <form action={act} className="space-y-2">
                <input type="hidden" name="rid" value={invoice.id} />
                <input className="input" name="reason" placeholder="Reason" required />
                <button name="op" value="void" className="btn-danger w-full">Void invoice</button>
              </form>
            </Card>
          )}
          <Card title="Emails">
            {emails.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
              <ul className="space-y-1 text-xs">{emails.map((e) => <li key={e.id}>{fmt(e.sentAt, s.timezone, "d MMM HH:mm")} · {e.kind} · {e.status}</li>)}</ul>
            )}
          </Card>
          <Card title="History">
            <ul className="space-y-1 text-xs">{history.map((h) => <li key={h.id}>{fmt(h.createdAt, s.timezone, "d MMM HH:mm")} · {h.action}{h.actorId ? "" : " (automation)"}</li>)}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
