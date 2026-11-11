import Link from "next/link";
import type { ReactNode } from "react";
import { NavLinks } from "./nav-links";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="headline">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-medium">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between border-b-2 border-canvas px-4 py-3">
          <h2 className="text-base font-bold">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card border-t-4 border-forest-green p-4">
      <div className="label">{label}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{value}</div>
      {hint && <div className="muted mt-1">{hint}</div>}
    </div>
  );
}

/*
 * Status tones, built only from RxCloud tokens. No red exists in the palette, so the most urgent
 * states (overdue, suspended, no-show) use a solid Deep Blue badge, the strongest contrast available.
 */
const TONES: Record<string, string> = {
  good: "border border-forest-green bg-canvas text-forest-green-text",          // paid, active, completed
  info: "bg-secondary-aqua text-deep-blue",                                      // confirmed, issued
  attention: "bg-secondary-yellow text-deep-blue",                               // draft, pending, maintenance
  urgent: "bg-deep-blue text-canvas",                                            // overdue, suspended, no-show
  live: "bg-forest-green-text text-canvas",                                      // checked in
  neutral: "border border-deep-blue bg-canvas text-deep-blue",                   // cancelled, void, retired
};
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "good", PENDING: "attention", SUSPENDED: "urgent", CLOSED: "neutral",
  CONFIRMED: "info", PENDING_APPROVAL: "attention", CHECKED_IN: "live", COMPLETED: "good", CANCELLED: "neutral", REJECTED: "neutral", NO_SHOW: "urgent",
  DRAFT: "attention", ISSUED: "info", PAID: "good", VOID: "neutral", OVERDUE: "urgent",
  MAINTENANCE: "attention", RETIRED: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replaceAll("_", " ").toLowerCase()}</Badge>;
}

export function Flash({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  if (searchParams.error) return <div role="alert" className="notice-problem mb-4">{searchParams.error}</div>;
  if (searchParams.ok) return <div role="status" className="notice-ok mb-4">{searchParams.ok}</div>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm font-medium">{children}</div>;
}

export function Logo({ width = 128 }: { width?: number }) {
  // Full-colour lockup on canvas, unaltered; never below 128px wide (RxCloud logo-min).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/rxcloud-lockup.png" alt="RxCloud" width={Math.max(128, width)} height={Math.round((Math.max(128, width) * 246) / 689)} />;
}

export function Shell({
  brand, nav, user, children,
}: { brand: string; nav: { href: string; label: string }[]; user: { name: string; subtitle: string }; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="no-print border-b-2 border-forest-green bg-canvas">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-3">
            <Logo />
            <span className="border-l-2 border-forest-green pl-3 leading-tight">
              <span className="block text-lg font-bold">LabShare</span>
              <span className="block text-xs font-medium">{brand}</span>
            </span>
          </Link>
          <NavLinks items={nav} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <div className="text-right leading-tight">
              <div className="font-bold">{user.name}</div>
              <div className="text-xs font-medium">{user.subtitle}</div>
            </div>
            <form action="/logout" method="post"><button className="btn-secondary">Sign out</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
