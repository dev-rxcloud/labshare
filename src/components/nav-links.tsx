"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot, CalendarClock, CalendarDays, ChartColumn, FileText, FlaskConical, LayoutDashboard, Microscope, ReceiptText, Settings, Users, Building2,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard, bookings: CalendarDays, customers: Building2, equipment: Microscope, usage: ChartColumn,
  invoices: ReceiptText, automation: Bot, settings: Settings, book: FlaskConical, schedule: CalendarClock, team: Users, docs: FileText,
};

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS | string;
  section?: string;
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/admin" || href === "/portal" ? path === href : path.startsWith(href));
  const sections: { name?: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.name === item.section) last.items.push(item);
    else sections.push({ name: item.section, items: [item] });
  }
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:gap-5 lg:overflow-visible lg:pt-2" aria-label="Main">
      {sections.map((s, i) => (
        <div key={s.name ?? i} className="flex gap-1 lg:flex-col">
          {s.name && <div className="hidden px-3 pb-1 text-xs font-bold tracking-wide lg:block">{s.name}</div>}
          {s.items.map((n) => {
            const Icon = ICONS[n.icon] ?? FileText;
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
                  active ? "bg-canvas text-deep-blue" : "text-canvas hover:bg-forest-green-text"
                }`}
              >
                <Icon size={17} strokeWidth={2.2} aria-hidden />
                {n.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
