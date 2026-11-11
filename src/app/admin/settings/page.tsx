import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { errMsg, flash, int, str } from "@/lib/actions";
import { Card, Flash, PageHeader } from "@/components/ui";

async function save(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  try {
    const tz = str(fd, "timezone");
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new Error(`Unknown time zone "${tz}"`); }
    const pct = (k: string) => {
      const n = Number(str(fd, k) || 0);
      if (!(n >= 0 && n <= 100)) throw new Error(`${k} must be between 0 and 100`);
      return n;
    };
    const data = {
      facilityName: str(fd, "facilityName"),
      timezone: tz,
      currency: str(fd, "currency").toUpperCase() || "USD",
      billingEmail: str(fd, "billingEmail"),
      invoiceFooter: str(fd, "invoiceFooter"),
      taxRatePercent: pct("taxRatePercent"),
      slotMinutes: int(fd, "slotMinutes", 15),
      maxAdvanceDays: int(fd, "maxAdvanceDays", 60),
      lateCancelWindowHours: int(fd, "lateCancelWindowHours"),
      lateCancelFeePercent: pct("lateCancelFeePercent"),
      noShowFeePercent: pct("noShowFeePercent"),
      noShowGraceMinutes: int(fd, "noShowGraceMinutes", 30),
      autoGenerateInvoices: fd.get("autoGenerateInvoices") === "on",
      autoIssueInvoices: fd.get("autoIssueInvoices") === "on",
      autoIssueAfterDays: int(fd, "autoIssueAfterDays"),
      paymentTermsDays: int(fd, "paymentTermsDays", 30),
      reminderDaysBeforeDue: int(fd, "reminderDaysBeforeDue"),
      reminderEveryDaysOverdue: int(fd, "reminderEveryDaysOverdue"),
      suspendAfterDaysOverdue: int(fd, "suspendAfterDaysOverdue"),
      lateFeePercent: pct("lateFeePercent"),
    };
    if (![5, 10, 15, 30, 60].includes(data.slotMinutes)) throw new Error("Slot size must be 5, 10, 15, 30 or 60 minutes.");
    await prisma.facilitySettings.update({ where: { id: 1 }, data });
    await audit(user.id, "settings.update", "FacilitySettings", "1", data);
    flash("/admin/settings", "ok", "Settings saved.");
  } catch (e) {
    flash("/admin/settings", "error", errMsg(e));
  }
}

function Field({ label, name, value, type = "text", hint, step }: { label: string; name: string; value: string | number; type?: string; hint?: string; step?: string }) {
  return (
    <div>
      <label className="label" htmlFor={name}>{label}</label>
      <input className="input" id={name} name={name} type={type} defaultValue={value} step={step} />
      {hint && <p className="mt-1 text-xs text-deep-blue">{hint}</p>}
    </div>
  );
}

function Toggle({ label, name, checked, hint }: { label: string; name: string; checked: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5" />
      <span><span className="font-medium">{label}</span>{hint && <span className="block text-xs text-deep-blue">{hint}</span>}</span>
    </label>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  return (
    <>
      <PageHeader title="Settings" />
      <Flash searchParams={sp} />
      <form action={save} className="grid gap-6 lg:grid-cols-3">
        <Card title="Facility">
          <div className="space-y-3">
            <Field label="Facility name" name="facilityName" value={s.facilityName} />
            <Field label="Time zone (IANA)" name="timezone" value={s.timezone} hint="Used for opening hours and month boundaries." />
            <Field label="Currency" name="currency" value={s.currency} />
            <Field label="Tax rate %" name="taxRatePercent" type="number" step="0.001" value={s.taxRatePercent} />
            <Field label="Billing contact email" name="billingEmail" value={s.billingEmail} />
            <div>
              <label className="label">Invoice footer / payment instructions</label>
              <textarea className="input" name="invoiceFooter" rows={4} defaultValue={s.invoiceFooter} />
            </div>
          </div>
        </Card>
        <Card title="Booking policy">
          <div className="space-y-3">
            <Field label="Slot size (minutes)" name="slotMinutes" type="number" value={s.slotMinutes} />
            <Field label="Max days in advance" name="maxAdvanceDays" type="number" value={s.maxAdvanceDays} />
            <Field label="Late-cancellation window (hours)" name="lateCancelWindowHours" type="number" value={s.lateCancelWindowHours} />
            <Field label="Late-cancellation fee % of slot" name="lateCancelFeePercent" type="number" value={s.lateCancelFeePercent} />
            <Field label="No-show fee % of slot" name="noShowFeePercent" type="number" value={s.noShowFeePercent} />
            <Field label="No-show grace (minutes after start)" name="noShowGraceMinutes" type="number" value={s.noShowGraceMinutes} />
          </div>
        </Card>
        <Card title="Invoicing automation">
          <div className="space-y-3">
            <Toggle label="Generate invoices at month end" name="autoGenerateInvoices" checked={s.autoGenerateInvoices} hint="Drafts for every customer on the 1st." />
            <Toggle label="Issue clean drafts immediately" name="autoIssueInvoices" checked={s.autoIssueInvoices} hint="Drafts with warnings always wait for review." />
            <Field label="Auto-issue unreviewed drafts after (days)" name="autoIssueAfterDays" type="number" value={s.autoIssueAfterDays} hint="0 = never; drafts wait for you." />
            <Field label="Payment terms (days)" name="paymentTermsDays" type="number" value={s.paymentTermsDays} />
            <Field label="Reminder before due (days)" name="reminderDaysBeforeDue" type="number" value={s.reminderDaysBeforeDue} hint="0 = off" />
            <Field label="Overdue reminder every (days)" name="reminderEveryDaysOverdue" type="number" value={s.reminderEveryDaysOverdue} hint="0 = off" />
            <Field label="One-time late fee %" name="lateFeePercent" type="number" step="0.01" value={s.lateFeePercent} hint="0 = off" />
            <Field label="Suspend booking after (days overdue)" name="suspendAfterDaysOverdue" type="number" value={s.suspendAfterDaysOverdue} hint="0 = never; restored automatically on payment." />
          </div>
        </Card>
        <div className="lg:col-span-3"><button className="btn-primary">Save settings</button></div>
      </form>
    </>
  );
}
