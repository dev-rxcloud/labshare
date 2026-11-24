import Link from "next/link";
import {
  Activity, BadgeDollarSign, Ban, Bell, CalendarClock, CalendarRange, CircleCheck, Clock, FileCheck2, FilePlus2, FileX2, Gauge, History, Mail,
  Play, ReceiptText, RotateCcw, Settings2, ShieldCheck, TriangleAlert, Wallet, Zap, type LucideIcon,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings, type Settings } from "@/lib/settings";
import { runAutomation } from "@/lib/services/jobs";
import { isQuietRun, planAutomation, summarizeRun, type PlanKind, type PlannedAction } from "@/lib/services/automation-plan";
import { recentActivity, type ActivityCategory, type ActivityEvent } from "@/lib/services/activity";
import { periodBounds, periodOf } from "@/lib/domain/time";
import { audit } from "@/lib/audit";
import { errMsg, flash, str } from "@/lib/actions";
import { fmt, money, relativeTime } from "@/lib/format";
import { Badge, Card, Empty, Flash, PageHeader, Stat } from "@/components/ui";

/* ------------------------------------------------------------------------------------------------
 * Actions
 * ---------------------------------------------------------------------------------------------- */

async function runNow() {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  const r = await runAutomation(new Date());
  await audit(user.id, "automation.run_manual", "JobRun");
  flash("/admin/automation", r.ok ? "ok" : "error", r.ok ? `Run complete: ${summarizeRun(r.summary)}.` : `Run finished with errors: ${summarizeRun(r.summary)}.`);
}

/** Rule switches. Turning a numeric rule back on restores a sensible default; fine-tune it in Settings. */
const RULES = {
  autoGenerateInvoices: { label: "Month-end close", on: { autoGenerateInvoices: true }, off: { autoGenerateInvoices: false } },
  autoIssueAfterDays: { label: "Auto-issue after review window", on: { autoIssueAfterDays: 3 }, off: { autoIssueAfterDays: 0 } },
  autoIssueInvoices: { label: "Instant issue for clean drafts", on: { autoIssueInvoices: true }, off: { autoIssueInvoices: false } },
  reminders: { label: "Payment reminders", on: { reminderDaysBeforeDue: 7, reminderEveryDaysOverdue: 7 }, off: { reminderDaysBeforeDue: 0, reminderEveryDaysOverdue: 0 } },
  lateFeePercent: { label: "Late fee", on: { lateFeePercent: 1.5 }, off: { lateFeePercent: 0 } },
  suspendAfterDaysOverdue: { label: "Suspension for non-payment", on: { suspendAfterDaysOverdue: 45 }, off: { suspendAfterDaysOverdue: 0 } },
} as const;
type RuleKey = keyof typeof RULES;

async function toggleRule(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  try {
    const key = str(fd, "rule") as RuleKey;
    const rule = RULES[key];
    if (!rule) throw new Error("Unknown rule.");
    const enable = str(fd, "enable") === "1";
    await prisma.facilitySettings.update({ where: { id: 1 }, data: enable ? rule.on : rule.off });
    await audit(user.id, "settings.update", "FacilitySettings", "1", { rule: rule.label, enabled: enable });
    flash("/admin/automation", "ok", `${rule.label} turned ${enable ? "on" : "off"}.`);
  } catch (e) {
    flash("/admin/automation", "error", errMsg(e));
  }
}

/* ------------------------------------------------------------------------------------------------
 * Presentation helpers
 * ---------------------------------------------------------------------------------------------- */

const PLAN_ICON: Record<PlanKind, LucideIcon> = {
  close: FilePlus2, issue: FileCheck2, reminder: Bell, "late-fee": BadgeDollarSign, suspend: Ban, "no-show": Clock, "auto-checkout": RotateCcw, "approval-expiry": CalendarClock,
};
const ACTIVITY_ICON: Record<ActivityEvent["icon"], LucideIcon> = {
  invoice: FilePlus2, issue: FileCheck2, mail: Mail, payment: Wallet, fee: BadgeDollarSign, suspend: Ban, reinstate: ShieldCheck, booking: CalendarRange, settings: Settings2, run: Play, void: FileX2,
};

function IconChip({ icon: Icon, tone = "aqua" }: { icon: LucideIcon; tone?: "aqua" | "grey" | "blue" }) {
  const cls = tone === "blue" ? "bg-deep-blue text-canvas" : tone === "grey" ? "bg-secondary-grey text-deep-blue" : "bg-secondary-aqua text-deep-blue";
  return <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cls}`}><Icon size={16} aria-hidden /></span>;
}

function Switch({ rule, on }: { rule: RuleKey; on: boolean }) {
  return (
    <form action={toggleRule}>
      <input type="hidden" name="rule" value={rule} />
      <input type="hidden" name="enable" value={on ? "0" : "1"} />
      <button
        role="switch"
        aria-checked={on}
        aria-label={`${RULES[rule].label}: ${on ? "on" : "off"}`}
        title={`Turn ${on ? "off" : "on"}`}
        className={`relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest-green focus-visible:ring-offset-2 ${
          on ? "border-forest-green-text bg-forest-green-text" : "border-deep-blue bg-secondary-grey"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full transition-transform ${on ? "translate-x-6 bg-canvas" : "translate-x-1 bg-deep-blue"}`} />
      </button>
    </form>
  );
}

function when(d: Date, tz: string, now: Date) {
  const sameDay = fmt(d, tz, "yyyy-MM-dd") === fmt(now, tz, "yyyy-MM-dd");
  return sameDay ? `Today ${fmt(d, tz, "HH:mm")}` : fmt(d, tz, "EEE d MMM, HH:mm");
}

/** Collapse identical actions (e.g. five no-shows on the same instrument) into one row with a count. */
function grouped(actions: PlannedAction[]): PlannedAction[] {
  const out: (PlannedAction & { count: number })[] = [];
  for (const a of actions) {
    const g = out.find((o) => o.kind === a.kind && o.title === a.title && o.at <= a.at && a.at.getTime() - o.at.getTime() < 3600000);
    if (g) {
      g.count++;
      g.amountCents = (g.amountCents ?? 0) + (a.amountCents ?? 0) || undefined;
      if (g.detail !== a.detail) g.detail = undefined;
    } else out.push({ ...a, count: 1 });
  }
  return out.map((o) => (o.count > 1 ? { ...o, title: `${o.count} × ${o.title}` } : o));
}

function PlanRow({ a, tz, now, currency }: { a: PlannedAction; tz: string; now: Date; currency: string }) {
  const body = (
    <div className="flex items-start gap-3 py-3">
      <IconChip icon={PLAN_ICON[a.kind]} tone={a.at <= now ? "blue" : "aqua"} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold">{a.title}</div>
        {a.detail && <div className="muted mt-0.5">{a.detail}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs font-bold whitespace-nowrap">{a.at <= now ? "Next run" : relativeTime(a.at, now)}</div>
        <div className="muted whitespace-nowrap">{a.at <= now ? "due now" : when(a.at, tz, now)}</div>
        {a.amountCents != null && a.amountCents > 0 && <div className="mt-0.5 text-xs font-bold tabular-nums">{money(a.amountCents, currency)}</div>}
      </div>
    </div>
  );
  return a.href ? <Link href={a.href} className="block rounded-lg px-2 -mx-2 hover:bg-secondary-grey">{body}</Link> : <div className="px-2 -mx-2">{body}</div>;
}

function ActivityRow({ e, tz, now }: { e: ActivityEvent; tz: string; now: Date }) {
  const body = (
    <div className="flex items-start gap-3 py-3">
      <IconChip icon={ACTIVITY_ICON[e.icon]} tone={e.automated ? "aqua" : "grey"} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{e.text}</div>
        <div className="muted mt-0.5 flex items-center gap-1.5">
          {e.automated ? <><Zap size={12} aria-hidden /> Automation</> : e.actor} · {fmt(e.at, tz, "d MMM, HH:mm")}
        </div>
      </div>
      <div className="muted shrink-0 whitespace-nowrap">{relativeTime(e.at, now)}</div>
    </div>
  );
  return e.href ? <Link href={e.href} className="block rounded-lg px-2 -mx-2 hover:bg-secondary-grey">{body}</Link> : <div className="px-2 -mx-2">{body}</div>;
}

interface Stage {
  n: number;
  icon: LucideIcon;
  title: string;
  on: boolean;
  rule?: RuleKey;
  text: string;
}

function stages(s: Settings): Stage[] {
  return [
    {
      n: 1, icon: Gauge, title: "Usage capture", on: true,
      text: `No-show recorded ${s.noShowGraceMinutes} min after start (charged ${s.noShowFeePercent}%). Sessions left open 2 h past their end are closed and flagged. Unanswered approval requests expire at their start time.`,
    },
    {
      n: 2, icon: FilePlus2, title: "Month-end close", rule: "autoGenerateInvoices", on: s.autoGenerateInvoices,
      text: s.autoGenerateInvoices
        ? `A draft invoice for every billable customer at 00:00 on the 1st (${s.timezone}): usage, no-shows, late cancellations, rent, credits, plan discounts and ${s.taxRatePercent}% tax.`
        : "Off: generate drafts yourself from Invoices.",
    },
    {
      n: 3, icon: FileCheck2, title: "Review window, then auto-issue", rule: "autoIssueAfterDays", on: s.autoIssueAfterDays > 0,
      text: s.autoIssueAfterDays > 0 ? `Drafts wait ${s.autoIssueAfterDays} day(s) for your review, then are issued and emailed automatically.` : "Off: drafts wait until you issue them.",
    },
    {
      n: 4, icon: Zap, title: "Instant issue for clean drafts", rule: "autoIssueInvoices", on: s.autoIssueInvoices,
      text: s.autoIssueInvoices ? "Drafts with nothing to check go out immediately. Drafts with warnings still wait for review." : "Off: every draft goes through the review window.",
    },
    { n: 5, icon: CalendarClock, title: "Payment terms", on: true, text: `Due ${s.paymentTermsDays} days after issue. Customer-specific terms override this.` },
    {
      n: 6, icon: Bell, title: "Reminders", rule: "reminders", on: s.reminderDaysBeforeDue > 0 || s.reminderEveryDaysOverdue > 0,
      text:
        s.reminderDaysBeforeDue > 0 || s.reminderEveryDaysOverdue > 0
          ? `${s.reminderDaysBeforeDue > 0 ? `${s.reminderDaysBeforeDue} days before the due date` : "No pre-due reminder"}${s.reminderEveryDaysOverdue > 0 ? `, then every ${s.reminderEveryDaysOverdue} days while overdue` : ""}. Sent to the billing contact and organisation admins.`
          : "Off: no reminder emails.",
    },
    {
      n: 7, icon: BadgeDollarSign, title: "Late fee", rule: "lateFeePercent", on: s.lateFeePercent > 0,
      text: s.lateFeePercent > 0 ? `One-time ${s.lateFeePercent}% of the unpaid balance, added to the customer's next invoice.` : "Off: no late fees.",
    },
    {
      n: 8, icon: ShieldCheck, title: "Suspension and reinstatement", rule: "suspendAfterDaysOverdue", on: s.suspendAfterDaysOverdue > 0,
      text: s.suspendAfterDaysOverdue > 0 ? `Booking access paused at ${s.suspendAfterDaysOverdue} days overdue, and restored automatically once overdue invoices are paid.` : "Off: accounts are never suspended automatically.",
    },
  ];
}

const EMAIL_KIND: Record<string, string> = {
  "invoice.issued": "Invoice", "invoice.payment": "Receipt", "invoice.reminder.upcoming": "Reminder", "invoice.reminder.overdue": "Overdue notice",
  "customer.suspended": "Suspension", "customer.reinstated": "Reinstatement", booking: "Booking",
};

const TABS = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "schedule", label: "Schedule", icon: CalendarClock },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "runs", label: "Run history", icon: History },
  { id: "emails", label: "Emails", icon: Mail },
] as const;

/* ------------------------------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------------------------------- */

export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser(["FACILITY_ADMIN"]);
  const s = await getSettings();
  const sp = await searchParams;
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? "overview") as (typeof TABS)[number]["id"];
  const now = new Date();

  const [plan, lastRun, openInvoices, emails30] = await Promise.all([
    planAutomation(now, s),
    prisma.jobRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.invoice.findMany({ where: { status: "ISSUED" }, select: { totalCents: true, paidCents: true, dueAt: true } }),
    prisma.emailLog.count({ where: { sentAt: { gte: new Date(now.getTime() - 30 * 86400000) } } }),
  ]);
  const outstanding = openInvoices.reduce((t, i) => t + i.totalCents - i.paidCents, 0);
  const nextClose = s.autoGenerateInvoices ? periodBounds(periodOf(now, s.timezone), s.timezone).end : null;
  const closeAction = plan.upcoming.find((a) => a.kind === "close");

  // Scheduler health: the automation should run at least hourly.
  const ageMin = lastRun ? (now.getTime() - lastRun.startedAt.getTime()) / 60000 : Infinity;
  const health =
    !lastRun ? { tone: "attention" as const, text: "Never run", hint: "Schedule /api/cron/run hourly, or click Run now." }
    : lastRun.ok === false ? { tone: "urgent" as const, text: "Last run had errors", hint: `See Run history · ${relativeTime(lastRun.startedAt, now)}` }
    : ageMin > 90 ? { tone: "attention" as const, text: "Scheduler idle", hint: `Last run ${relativeTime(lastRun.startedAt, now)}. Expected hourly.` }
    : { tone: "good" as const, text: "Healthy", hint: `Last run ${relativeTime(lastRun.startedAt, now)} · runs hourly` };

  const tabHref = (id: string, extra: Record<string, string> = {}) => `?${new URLSearchParams({ tab: id, ...extra })}`;

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={health.tone}>{health.tone === "good" ? <CircleCheck size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}{health.text}</Badge>
            <span>{health.hint}</span>
          </span>
        }
        actions={
          <form action={runNow}>
            <button className="btn-primary"><Play size={15} aria-hidden /> Run now{plan.dueNow.length ? ` · ${plan.dueNow.length} due` : ""}</button>
          </form>
        }
      />
      <Flash searchParams={sp} />

      <nav className="no-print mb-6 flex gap-1 overflow-x-auto border-b border-secondary-grey" aria-label="Automation sections">
        {TABS.map((t) => {
          const active = t.id === tab;
          const count = t.id === "schedule" ? plan.dueNow.length + plan.upcoming.length : undefined;
          return (
            <Link
              key={t.id}
              href={tabHref(t.id)}
              aria-current={active ? "page" : undefined}
              className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-bold ${active ? "border-forest-green" : "border-canvas hover:border-secondary-grey"}`}
            >
              <t.icon size={15} aria-hidden />
              {t.label}
              {count ? <span className="rounded-full bg-secondary-grey px-1.5 text-xs">{count}</span> : null}
            </Link>
          );
        })}
      </nav>

      {tab === "overview" && <Overview />}
      {tab === "schedule" && <Schedule />}
      {tab === "activity" && <ActivityTab />}
      {tab === "runs" && <Runs />}
      {tab === "emails" && <Emails />}
    </>
  );

  /* ---------------------------------------------------------------- Overview */
  async function Overview() {
    const activity = await recentActivity({ limit: 8 });
    return (
      <>
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            icon={<FilePlus2 size={20} aria-hidden />}
            label="Next month-end close"
            value={nextClose ? fmt(nextClose, s.timezone, "d MMM") : "Off"}
            hint={nextClose ? `${relativeTime(nextClose, now)}${closeAction?.amountCents ? ` · ${money(closeAction.amountCents, s.currency)} so far` : ""}` : "Turn on Month-end close below"}
          />
          <Stat icon={<Zap size={20} aria-hidden />} label="Due on the next run" value={plan.dueNow.length} hint={plan.dueNow.length ? "Run now to act on them immediately" : "Nothing waiting"} />
          <Stat icon={<ReceiptText size={20} aria-hidden />} label="In collection" value={money(outstanding, s.currency)} hint={`${openInvoices.length} open · ${plan.overdueInvoices} overdue`} />
          <Stat icon={<Mail size={20} aria-hidden />} label="Emails · last 30 days" value={emails30} hint={process.env.RESEND_API_KEY ? "Delivered via Resend" : "Logged only: no email service connected"} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
          <Card title="Billing workflow" actions={<Link href="/admin/settings" className="link text-sm">Fine-tune in Settings</Link>}>
            <ol className="relative">
              {stages(s).map((st, i, all) => (
                <li key={st.n} className="relative flex gap-4 pb-5 last:pb-0">
                  {i < all.length - 1 && <span aria-hidden className={`absolute top-9 left-4 h-[calc(100%-2rem)] border-l-2 ${st.on ? "border-forest-green" : "border-secondary-grey"}`} />}
                  <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${st.on ? "bg-deep-blue text-canvas" : "border border-deep-blue bg-canvas text-deep-blue"}`}>
                    <st.icon size={15} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-bold">{st.title}</div>
                      {st.rule ? <Switch rule={st.rule} on={st.on} /> : <Badge tone="neutral">Always on</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed font-medium">{st.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <div className="space-y-6">
            <Card title="Due on the next run" actions={plan.dueNow.length > 0 && <Badge tone="urgent">{plan.dueNow.length}</Badge>}>
              {plan.dueNow.length === 0 ? (
                <Empty>Nothing is waiting. The next run will only check for changes.</Empty>
              ) : (
                <div className="divide-y divide-secondary-grey">{grouped(plan.dueNow).slice(0, 5).map((a, i) => <PlanRow key={i} a={a} tz={s.timezone} now={now} currency={s.currency} />)}</div>
              )}
            </Card>
            <Card title="Coming up" actions={<Link href={tabHref("schedule")} className="link text-sm">Full schedule</Link>}>
              {plan.upcoming.length === 0 ? (
                <Empty>Nothing scheduled in the next 60 days.</Empty>
              ) : (
                <div className="divide-y divide-secondary-grey">{grouped(plan.upcoming).slice(0, 5).map((a, i) => <PlanRow key={i} a={a} tz={s.timezone} now={now} currency={s.currency} />)}</div>
              )}
            </Card>
          </div>
        </div>

        <Card className="mt-6" title="Recent activity" actions={<Link href={tabHref("activity")} className="link text-sm">All activity</Link>}>
          {activity.length === 0 ? <Empty>No activity yet.</Empty> : <div className="divide-y divide-secondary-grey">{activity.map((e) => <ActivityRow key={e.id} e={e} tz={s.timezone} now={now} />)}</div>}
        </Card>
      </>
    );
  }

  /* ---------------------------------------------------------------- Schedule */
  async function Schedule() {
    const groups = new Map<string, PlannedAction[]>();
    for (const a of plan.dueNow) groups.set("Due on the next run", [...(groups.get("Due on the next run") ?? []), a]);
    for (const a of plan.upcoming) {
      const k = fmt(a.at, s.timezone, "EEEE d MMMM");
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    return (
      <Card>
        <p className="mb-4 text-sm font-medium">
          Everything the automation will do in the next 60 days, based on today&apos;s data. Items marked &quot;if still unpaid&quot; drop off when the customer pays; dates move when you change a rule.
        </p>
        {groups.size === 0 ? (
          <Empty>Nothing scheduled.</Empty>
        ) : (
          <div className="space-y-6">
            {[...groups].map(([day, items]) => (
              <section key={day}>
                <h3 className="mb-1 text-xs font-bold tracking-wide uppercase">{day}</h3>
                <div className="divide-y divide-secondary-grey">{grouped(items).map((a, i) => <PlanRow key={i} a={a} tz={s.timezone} now={now} currency={s.currency} />)}</div>
              </section>
            ))}
          </div>
        )}
      </Card>
    );
  }

  /* ---------------------------------------------------------------- Activity */
  async function ActivityTab() {
    const cat = (["billing", "bookings", "accounts", "settings"] as const).find((c) => c === sp.cat) as ActivityCategory | undefined;
    const autoOnly = sp.by === "automation";
    const events = await recentActivity({ limit: 150, category: cat, automatedOnly: autoOnly });
    const groups = new Map<string, ActivityEvent[]>();
    for (const e of events) {
      const k = fmt(e.at, s.timezone, "EEEE d MMMM yyyy");
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const chip = (label: string, params: Record<string, string>, active: boolean) => (
      <Link key={label} href={tabHref("activity", params)} className={`rounded-full px-3 py-1 text-xs font-bold ${active ? "bg-deep-blue text-canvas" : "border border-secondary-grey hover:bg-secondary-grey"}`}>{label}</Link>
    );
    const keep: Record<string, string> = autoOnly ? { by: "automation" } : {};
    return (
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {chip("All", keep, !cat)}
          {(["billing", "bookings", "accounts", "settings"] as const).map((c) => chip(c[0].toUpperCase() + c.slice(1), { ...keep, cat: c }, cat === c))}
          <span className="mx-1 h-5 border-l border-secondary-grey" />
          {chip("Automation only", { ...(cat ? { cat } : {}), ...(autoOnly ? {} : { by: "automation" }) }, autoOnly)}
        </div>
        {groups.size === 0 ? (
          <Empty>No activity matches.</Empty>
        ) : (
          <div className="space-y-6">
            {[...groups].map(([day, items]) => (
              <section key={day}>
                <h3 className="mb-1 text-xs font-bold tracking-wide uppercase">{day}</h3>
                <div className="divide-y divide-secondary-grey">{items.map((e) => <ActivityRow key={e.id} e={e} tz={s.timezone} now={now} />)}</div>
              </section>
            ))}
          </div>
        )}
      </Card>
    );
  }

  /* ---------------------------------------------------------------- Runs */
  async function Runs() {
    const showQuiet = sp.quiet === "1";
    const runs = await prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 200 });
    const shown = showQuiet ? runs : runs.filter((r) => !isQuietRun(r.summary) || r.ok === false);
    const hidden = runs.length - shown.length;
    return (
      <Card
        actions={
          <Link href={tabHref("runs", showQuiet ? {} : { quiet: "1" })} className="link text-sm">
            {showQuiet ? "Hide runs where nothing was due" : `Show all runs${hidden ? ` (${hidden} quiet)` : ""}`}
          </Link>
        }
        title="Run history"
      >
        {shown.length === 0 ? (
          <Empty>{runs.length ? `All ${runs.length} recent runs found nothing to do.` : "No runs yet."}</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Started</th><th>Duration</th><th>Result</th><th>What happened</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmt(r.startedAt, s.timezone, "d MMM yyyy, HH:mm")}<div className="muted">{relativeTime(r.startedAt, now)}</div></td>
                  <td className="whitespace-nowrap tabular-nums">{r.finishedAt ? `${((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)} s` : "running"}</td>
                  <td>{r.ok === false ? <Badge tone="urgent">Errors</Badge> : r.ok ? <Badge tone="good">Succeeded</Badge> : <Badge tone="attention">Running</Badge>}</td>
                  <td className="font-semibold">{summarizeRun(r.summary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );
  }

  /* ---------------------------------------------------------------- Emails */
  async function Emails() {
    const list = await prisma.emailLog.findMany({ orderBy: { sentAt: "desc" }, take: 100 });
    return (
      <Card title="Emails sent by LabShare">
        {!process.env.RESEND_API_KEY && (
          <div className="notice-problem mb-4 text-xs"><TriangleAlert size={16} className="shrink-0" aria-hidden />No email service is connected, so these were recorded but not delivered. Set RESEND_API_KEY to send them for real.</div>
        )}
        {list.length === 0 ? (
          <Empty>No emails yet.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Sent</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{fmt(e.sentAt, s.timezone, "d MMM, HH:mm")}</td>
                  <td><Badge tone={e.kind.includes("overdue") || e.kind.includes("suspend") ? "attention" : "info"}>{EMAIL_KIND[e.kind] ?? e.kind}</Badge></td>
                  <td className="text-xs break-all">{e.to}</td>
                  <td>
                    <details>
                      <summary className="cursor-pointer font-semibold">{e.subject}</summary>
                      <pre className="mt-2 rounded-lg bg-secondary-grey p-3 font-sans text-xs whitespace-pre-wrap">{e.body}</pre>
                    </details>
                  </td>
                  <td className="text-xs">{e.status === "sent" ? "Delivered" : e.status === "logged" ? "Logged" : e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );
  }
}
