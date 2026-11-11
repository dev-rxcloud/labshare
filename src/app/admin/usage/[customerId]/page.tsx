import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { buildStatement, generateInvoice } from "@/lib/services/invoicing";
import { staffSetActualTimes } from "@/lib/services/bookings";
import { fromLocal, periodBounds, periodOf, previousPeriod } from "@/lib/domain/time";
import { centsField, errMsg, flash, str } from "@/lib/actions";
import { fmt, money, periodLabel } from "@/lib/format";
import { Card, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { PeriodPicker, StatementTable } from "@/components/statement-table";

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const customerId = str(fd, "customerId");
  const period = str(fd, "period");
  const back = `/admin/usage/${customerId}?period=${period}`;
  try {
    switch (str(fd, "op")) {
      case "adjust": {
        const amount = centsField(fd, "amount") * (str(fd, "sign") === "credit" ? -1 : 1);
        if (!amount) throw new Error("Enter an amount.");
        const a = await prisma.billingAdjustment.create({ data: { customerId, period, description: str(fd, "description"), amountCents: amount, createdById: user.id } });
        await audit(user.id, "adjustment.create", "BillingAdjustment", a.id, { amount });
        flash(back, "ok", "Adjustment added. Recalculate the draft invoice to include it.");
        break;
      }
      case "delete-adjustment": {
        const a = await prisma.billingAdjustment.findUniqueOrThrow({ where: { id: str(fd, "adjustmentId") } });
        if (a.invoiceLineId) throw new Error("Already invoiced.");
        await prisma.billingAdjustment.delete({ where: { id: a.id } });
        flash(back, "ok", "Adjustment removed.");
        break;
      }
      case "times": {
        const date = str(fd, "date");
        await staffSetActualTimes(user.id, str(fd, "bookingId"), fromLocal(date, str(fd, "in"), s.timezone), fromLocal(date, str(fd, "out"), s.timezone));
        flash(back, "ok", "Actual times updated.");
        break;
      }
      case "generate": {
        const r = await generateInvoice(customerId, period, user.id);
        if (r.invoiceId) flash(`/admin/invoices/${r.invoiceId}`, "ok", `Draft ${r.status}.`);
        flash(back, "error", `No invoice: ${r.reason}.`);
      }
    }
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function CustomerUsage({ params, searchParams }: { params: Promise<{ customerId: string }>; searchParams: Promise<{ period?: string; ok?: string; error?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const { customerId } = await params;
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, include: { tier: true } });
  if (!customer) notFound();
  const period = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : previousPeriod(periodOf(new Date(), s.timezone));
  const { start, end } = periodBounds(period, s.timezone);
  const [statement, bookings, adjustments, invoice] = await Promise.all([
    buildStatement(customerId, period, s),
    prisma.booking.findMany({ where: { customerId, startsAt: { gte: start, lt: end } }, include: { equipment: true, user: true }, orderBy: { startsAt: "asc" } }),
    prisma.billingAdjustment.findMany({ where: { customerId, period }, orderBy: { createdAt: "asc" } }),
    prisma.invoice.findFirst({ where: { customerId, period, status: { not: "VOID" } } }),
  ]);
  const hidden = (
    <>
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="period" value={period} />
    </>
  );

  return (
    <>
      <PageHeader
        title={`${customer.name} · ${periodLabel(period)}`}
        subtitle={`${customer.tier.name} plan (${Number(customer.tier.discountPercent)}% discount)${customer.monthlyOfficeRentCents ? ` · office rent ${money(customer.monthlyOfficeRentCents, s.currency)}/month` : ""}`}
        actions={<><PeriodPicker period={period} base={`/admin/usage/${customerId}`} /><Link className="btn-secondary" href={`/admin/customers/${customerId}`}>Customer</Link></>}
      />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={invoice && invoice.status !== "DRAFT" ? "Uninvoiced items (will roll into the next invoice)" : "Statement preview (exactly what will be invoiced)"}
          actions={
            invoice ? <Link className="link text-sm" href={`/admin/invoices/${invoice.id}`}>Invoice {invoice.number} <StatusBadge status={invoice.status} /></Link> : (
              <form action={act}>{hidden}<button name="op" value="generate" className="btn-primary">Generate draft</button></form>
            )
          }
        >
          <StatementTable statement={statement} currency={s.currency} />
        </Card>
        <Card title="Add credit or charge">
          <form action={act} className="space-y-3">
            {hidden}
            <input type="hidden" name="op" value="adjust" />
            <div><label className="label">Description</label><input className="input" name="description" required placeholder="e.g. Instrument downtime credit" /></div>
            <div className="grid grid-cols-2 gap-2">
              <select className="input" name="sign"><option value="credit">Credit (−)</option><option value="charge">Charge (+)</option></select>
              <input className="input" name="amount" placeholder="0.00" required />
            </div>
            <button className="btn-secondary w-full">Add</button>
          </form>
          {adjustments.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm">
              {adjustments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>{a.description}</span>
                  <span className="flex items-center gap-2 tabular-nums">{money(a.amountCents, s.currency)}
                    {!a.invoiceLineId && <form action={act}>{hidden}<input type="hidden" name="adjustmentId" value={a.id} /><button name="op" value="delete-adjustment" className="text-xs font-bold text-deep-blue">remove</button></form>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-3" title="Bookings in this period">
          <table className="table">
            <thead><tr><th>Equipment</th><th>User</th><th>Booked</th><th>Status</th><th>Actual (correct from instrument logs)</th></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td>{b.equipment.name}</td>
                  <td>{b.user.name}</td>
                  <td className="whitespace-nowrap">{fmt(b.startsAt, s.timezone, "d MMM HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")}</td>
                  <td><StatusBadge status={b.status} />{b.autoClosed && <div className="text-xs font-bold text-deep-blue">auto-closed</div>}{b.invoiceLineId && <div className="text-xs text-deep-blue">invoiced</div>}</td>
                  <td>
                    {["COMPLETED", "CHECKED_IN", "NO_SHOW"].includes(b.status) && !b.invoiceLineId ? (
                      <form action={act} className="flex items-center gap-1">
                        {hidden}
                        <input type="hidden" name="bookingId" value={b.id} />
                        <input type="hidden" name="date" value={fmt(b.startsAt, s.timezone, "yyyy-MM-dd")} />
                        <input className="input w-24" type="time" name="in" defaultValue={fmt(b.checkedInAt ?? b.startsAt, s.timezone, "HH:mm")} />
                        <span>–</span>
                        <input className="input w-24" type="time" name="out" defaultValue={fmt(b.checkedOutAt ?? b.endsAt, s.timezone, "HH:mm")} />
                        <button name="op" value="times" className="btn-secondary">Save</button>
                      </form>
                    ) : (
                      <span className="text-xs text-deep-blue">{b.checkedInAt ? `${fmt(b.checkedInAt, s.timezone, "HH:mm")}–${fmt(b.checkedOutAt, s.timezone, "HH:mm")}` : "—"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
