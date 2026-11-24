/** Plain-English activity feed built from the audit log. */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { money } from "../format";

export type ActivityCategory = "billing" | "bookings" | "accounts" | "settings";

export interface ActivityEvent {
  id: string;
  at: Date;
  actor: string; // "Automation" or a person's name
  automated: boolean;
  category: ActivityCategory;
  icon: "invoice" | "issue" | "mail" | "payment" | "fee" | "suspend" | "reinstate" | "booking" | "settings" | "run" | "void";
  text: string;
  href?: string;
}

const CATEGORY_PREFIXES: Record<ActivityCategory, string[]> = {
  billing: ["invoice.", "adjustment."],
  bookings: ["booking."],
  accounts: ["customer.", "user.", "grant.", "rate.", "certification."],
  settings: ["settings.", "automation.", "tier.", "equipment.", "maintenance."],
};

function categoryOf(action: string): ActivityCategory {
  for (const [c, prefixes] of Object.entries(CATEGORY_PREFIXES)) if (prefixes.some((p) => action.startsWith(p))) return c as ActivityCategory;
  return "settings";
}

export async function recentActivity(opts: { limit?: number; category?: ActivityCategory; automatedOnly?: boolean } = {}): Promise<ActivityEvent[]> {
  const where: Prisma.AuditLogWhereInput = {
    ...(opts.category ? { OR: CATEGORY_PREFIXES[opts.category].map((p) => ({ action: { startsWith: p } })) } : {}),
    ...(opts.automatedOnly ? { actorId: null } : {}),
  };
  const logs = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: opts.limit ?? 50 });
  const ids = (entity: string) => [...new Set(logs.filter((l) => l.entity === entity && l.entityId).map((l) => l.entityId!))];
  const [invoices, customers, bookings, users] = await Promise.all([
    prisma.invoice.findMany({ where: { id: { in: ids("Invoice") } }, include: { customer: { select: { name: true } } } }),
    prisma.customer.findMany({ where: { id: { in: ids("Customer") } }, select: { id: true, name: true } }),
    prisma.booking.findMany({ where: { id: { in: ids("Booking") } }, include: { equipment: { select: { name: true } }, customer: { select: { name: true } } } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.actorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } }),
  ]);
  const inv = new Map(invoices.map((i) => [i.id, i]));
  const cus = new Map(customers.map((c) => [c.id, c]));
  const bk = new Map(bookings.map((b) => [b.id, b]));
  const usr = new Map(users.map((u) => [u.id, u.name]));

  return logs.map((l) => {
    const data = (l.data ?? {}) as Record<string, unknown>;
    const i = l.entityId ? inv.get(l.entityId) : undefined;
    const c = l.entityId ? cus.get(l.entityId) : undefined;
    const b = l.entityId ? bk.get(l.entityId) : undefined;
    const invName = i ? `${i.number} (${i.customer.name})` : "an invoice";
    const invHref = i ? `/admin/invoices/${i.id}` : undefined;
    const bookingName = b ? `${b.equipment.name} for ${b.customer.name}` : "a booking that has since been removed";
    const bookingHref = b ? `/admin/bookings?customerId=${b.customerId}` : undefined;
    const custHref = l.entityId ? `/admin/customers/${l.entityId}` : undefined;
    const amt = (k: string) => (typeof data[k] === "number" && i ? money(data[k] as number, i.currency) : "");
    let e: Pick<ActivityEvent, "icon" | "text" | "href">;
    switch (l.action) {
      case "invoice.generate": e = { icon: "invoice", text: `Created draft invoice ${invName}`, href: invHref }; break;
      case "invoice.regenerate": e = { icon: "invoice", text: `Recalculated draft ${invName}`, href: invHref }; break;
      case "invoice.issue": {
        const reason = String(data.reason ?? "");
        e = { icon: "issue", text: `Issued and emailed ${invName}${i ? ` · ${money(i.totalCents, i.currency)}` : ""}${reason.startsWith("auto") ? ` · ${reason.replace(/^auto: /, "")}` : ""}`, href: invHref };
        break;
      }
      case "invoice.reminder_upcoming": e = { icon: "mail", text: `Sent payment reminder for ${invName}`, href: invHref }; break;
      case "invoice.reminder_overdue": e = { icon: "mail", text: `Sent overdue notice for ${invName}`, href: invHref }; break;
      case "invoice.late_fee": e = { icon: "fee", text: `Added ${amt("amountCents")} late fee for ${invName} to the next invoice`, href: invHref }; break;
      case "invoice.payment": e = { icon: "payment", text: `Recorded ${amt("amountCents")} payment on ${invName}`, href: invHref }; break;
      case "invoice.void": e = { icon: "void", text: `Voided ${invName}${data.reason ? ` · ${data.reason}` : ""}`, href: invHref }; break;
      case "customer.auto_suspend": e = { icon: "suspend", text: `Suspended booking access for ${c?.name ?? "a customer"} · overdue invoices`, href: custHref }; break;
      case "customer.reinstate": e = { icon: "reinstate", text: `Reinstated ${c?.name ?? "a customer"} · overdue invoices settled`, href: custHref }; break;
      case "customer.create": e = { icon: "settings", text: `Onboarded ${c?.name ?? "a customer"}`, href: custHref }; break;
      case "customer.update": e = { icon: "settings", text: `Updated account for ${c?.name ?? "a customer"}`, href: custHref }; break;
      case "booking.auto_no_show": e = { icon: "booking", text: `Recorded no-show: ${bookingName}`, href: bookingHref }; break;
      case "booking.auto_checkout": e = { icon: "booking", text: `Auto-closed forgotten session: ${bookingName} · flagged for review`, href: bookingHref }; break;
      case "booking.approval_expired": e = { icon: "booking", text: `Approval request expired: ${bookingName}`, href: bookingHref }; break;
      case "booking.confirmed": e = { icon: "booking", text: `Approved ${bookingName}`, href: bookingHref }; break;
      case "booking.rejected": e = { icon: "booking", text: `Declined ${bookingName}`, href: bookingHref }; break;
      case "booking.create": e = { icon: "booking", text: `Booked ${bookingName}`, href: bookingHref }; break;
      case "booking.cancel": e = { icon: "booking", text: `Cancelled ${bookingName}`, href: bookingHref }; break;
      case "settings.update": e = { icon: "settings", text: `Changed facility settings${data.rule ? `: ${data.rule} ${data.enabled ? "on" : "off"}` : ""}`, href: "/admin/settings" }; break;
      case "automation.run_manual": e = { icon: "run", text: "Ran the automation manually" }; break;
      default: e = { icon: "settings", text: l.action.replace(/[._]/g, " ") };
    }
    return { id: l.id, at: l.createdAt, actor: l.actorId ? usr.get(l.actorId) ?? "Someone" : "Automation", automated: !l.actorId, category: categoryOf(l.action), ...e };
  });
}
