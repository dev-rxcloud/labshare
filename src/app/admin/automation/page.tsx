import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { runAutomation } from "@/lib/services/jobs";
import { audit } from "@/lib/audit";
import { flash } from "@/lib/actions";
import { fmt } from "@/lib/format";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";

async function runNow() {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const r = await runAutomation(new Date());
  await audit(user.id, "automation.run_manual", "JobRun");
  flash("/admin/automation", r.ok ? "ok" : "error", r.ok ? "Automation ran successfully." : "Automation finished with errors — see the run log.");
}

export default async function AutomationPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const [runs, emails] = await Promise.all([
    prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    prisma.emailLog.findMany({ orderBy: { sentAt: "desc" }, take: 50 }),
  ]);
  const rules = [
    ["Housekeeping", `Confirmed bookings not checked in ${s.noShowGraceMinutes} min after start become no-shows; sessions left checked-in 2 h past their end are checked out automatically and flagged; unapproved requests expire at their start time.`],
    ["Month-end close", s.autoGenerateInvoices ? "On the 1st, a draft invoice is generated for every active or suspended customer for the previous month (usage, no-shows, late cancellations, office rent, adjustments, plan discount, tax)." : "Disabled — generate invoices manually from the Invoices page."],
    ["Issuing", s.autoIssueInvoices ? `Clean drafts are issued and emailed immediately; drafts with warnings wait for review and are issued after ${s.autoIssueAfterDays} days.` : s.autoIssueAfterDays > 0 ? `Drafts wait for admin review and are issued automatically after ${s.autoIssueAfterDays} days.` : "Drafts are only issued manually."],
    ["Payment terms", `Due ${s.paymentTermsDays} days after issue (customer-specific terms override).`],
    ["Reminders", `${s.reminderDaysBeforeDue > 0 ? `One reminder ${s.reminderDaysBeforeDue} days before due; ` : ""}${s.reminderEveryDaysOverdue > 0 ? `overdue reminders every ${s.reminderEveryDaysOverdue} days.` : "no overdue reminders."}`],
    ["Late fee", s.lateFeePercent > 0 ? `One-time ${s.lateFeePercent}% of the outstanding balance, added to the next invoice.` : "None."],
    ["Suspension", s.suspendAfterDaysOverdue > 0 ? `Booking access is suspended when an invoice is ${s.suspendAfterDaysOverdue}+ days overdue, and restored automatically when overdue invoices are paid.` : "Never automatic."],
  ];
  return (
    <>
      <PageHeader title="Automation" subtitle="The scheduler calls /api/cron/run hourly. Every step is idempotent." actions={<form action={runNow}><button className="btn-primary">Run now</button></form>} />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Active rules (edit in Settings)">
          <dl className="space-y-3 text-sm">
            {rules.map(([k, v]) => <div key={k}><dt className="font-medium">{k}</dt><dd className="text-deep-blue">{v}</dd></div>)}
          </dl>
        </Card>
        <Card title="Recent runs">
          {runs.length === 0 ? <Empty>No runs yet.</Empty> : (
            <ul className="space-y-2 text-xs">
              {runs.map((r) => (
                <li key={r.id} className="rounded border border-secondary-grey p-2">
                  <div className="mb-1 flex justify-between"><span className="font-medium">{fmt(r.startedAt, s.timezone)}</span><StatusBadge status={r.ok ? "COMPLETED" : r.ok === false ? "NO_SHOW" : "CONFIRMED"} /></div>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-deep-blue">{JSON.stringify(r.summary)}</pre>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Email log" className="lg:col-span-2">
          {emails.length === 0 ? <Empty>No emails sent yet.</Empty> : (
            <table className="table">
              <thead><tr><th>Sent</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
              <tbody>
                {emails.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{fmt(e.sentAt, s.timezone, "d MMM HH:mm")}</td>
                    <td className="text-xs">{e.kind}</td>
                    <td className="text-xs">{e.to}</td>
                    <td><details><summary className="cursor-pointer">{e.subject}</summary><pre className="mt-2 whitespace-pre-wrap text-xs text-deep-blue">{e.body}</pre></details></td>
                    <td className="text-xs">{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
