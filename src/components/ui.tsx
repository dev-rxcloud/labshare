import Link from "next/link";
import type { ReactNode } from "react";
import { CircleCheck, LogOut, TriangleAlert } from "lucide-react";
import { NavLinks, type NavItem } from "./nav-links";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="headline">{title}</h1>
        {subtitle && <div className="mt-1.5 text-sm font-medium">{subtitle}</div>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-1">
          <h2 className="text-[15px] font-bold">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5 pt-3">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card flex items-start gap-4 p-5">
      {icon && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary-aqua text-deep-blue">{icon}</div>}
      <div className="min-w-0">
        <div className="text-[13px] font-semibold">{label}</div>
        <div className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight">{value}</div>
        {hint && <div className="muted mt-1">{hint}</div>}
      </div>
    </div>
  );
}

/*
 * Status tones, built only from RxCloud tokens. No red exists in the palette, so the most urgent
 * states (overdue, suspended, no-show) use a solid Deep Blue badge, the strongest contrast available.
 */
const TONES: Record<string, string> = {
  good: "border border-forest-green bg-canvas text-forest-green-text",
  info: "bg-secondary-aqua text-deep-blue",
  attention: "bg-secondary-yellow text-deep-blue",
  urgent: "bg-deep-blue text-canvas",
  live: "bg-forest-green-text text-canvas",
  neutral: "border border-secondary-grey bg-canvas text-deep-blue",
};
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "good", PENDING: "attention", SUSPENDED: "urgent", CLOSED: "neutral",
  CONFIRMED: "info", PENDING_APPROVAL: "attention", CHECKED_IN: "live", COMPLETED: "good", CANCELLED: "neutral", REJECTED: "neutral", NO_SHOW: "urgent",
  DRAFT: "attention", ISSUED: "info", PAID: "good", VOID: "neutral", OVERDUE: "urgent",
  MAINTENANCE: "attention", RETIRED: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  const text = status.replaceAll("_", " ").toLowerCase();
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{text.charAt(0).toUpperCase() + text.slice(1)}</Badge>;
}

export function Flash({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  if (searchParams.error)
    return <div role="alert" className="notice-problem mb-6"><TriangleAlert size={18} className="mt-px shrink-0" aria-hidden />{searchParams.error}</div>;
  if (searchParams.ok)
    return <div role="status" className="notice-ok mb-6"><CircleCheck size={18} className="mt-px shrink-0 text-forest-green" aria-hidden />{searchParams.ok}</div>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-secondary-grey py-10 text-center text-sm font-medium">{children}</div>;
}

/** RxCloud lockup, unaltered, never below 128px wide. Full colour on canvas; white on deep-blue. */
export function Logo({ width = 128, variant = "colour" }: { width?: number; variant?: "colour" | "white" }) {
  const w = Math.max(128, width);
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={variant === "white" ? "/brand/rxcloud-lockup-white.png" : "/brand/rxcloud-lockup.png"} alt="RxCloud" width={w} height={Math.round((w * 246) / 689)} />;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

export function Shell({
  brand, nav, user, children,
}: { brand: string; nav: NavItem[]; user: { name: string; subtitle: string }; children: ReactNode }) {
  return (
    <div className="min-h-screen lg:flex">
      <aside className="no-print bg-deep-blue text-canvas lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-4 lg:block">
          <Link href="/" className="block" aria-label="LabShare home"><Logo variant="white" /></Link>
          <div className="text-right lg:mt-4 lg:text-left">
            <div className="text-[15px] font-bold leading-tight">LabShare</div>
            <div className="text-xs font-medium">{brand}</div>
          </div>
        </div>
        <NavLinks items={nav} />
        <div className="mt-auto hidden items-center gap-3 border-t border-forest-green px-5 py-4 lg:flex">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas text-sm font-bold text-deep-blue">{initials(user.name)}</div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-bold">{user.name}</div>
            <div className="truncate text-xs font-medium">{user.subtitle}</div>
          </div>
          <form action="/logout" method="post">
            <button className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-canvas hover:text-deep-blue" title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1 lg:pl-64">
        <div className="no-print flex items-center justify-end gap-3 border-b border-secondary-grey px-4 py-2 text-sm lg:hidden">
          <span className="font-bold">{user.name}</span>
          <form action="/logout" method="post"><button className="btn-secondary h-8">Sign out</button></form>
        </div>
        <main className="print-full mx-auto max-w-6xl px-4 py-8 sm:px-8 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
