import { requireCustomerUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { buildStatement } from "@/lib/services/invoicing";
import { periodOf } from "@/lib/domain/time";
import { periodLabel } from "@/lib/format";
import { Card, PageHeader } from "@/components/ui";
import { PeriodPicker, StatementTable } from "@/components/statement-table";
import { redirect } from "next/navigation";

export default async function PortalUsage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const user = await requireCustomerUser();
  if (user.role !== "CUSTOMER_ADMIN") redirect("/portal");
  const s = await getSettings();
  const sp = await searchParams;
  const current = periodOf(new Date(), s.timezone);
  const period = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : current;
  const statement = await buildStatement(user.customer.id, period, s);
  return (
    <>
      <PageHeader
        title={`Usage · ${periodLabel(period)}`}
        subtitle="Live view of uninvoiced charges. Items move to an invoice after month end."
        actions={<PeriodPicker period={period} base="/portal/usage" />}
      />
      <Card><StatementTable statement={statement} currency={s.currency} /></Card>
    </>
  );
}
