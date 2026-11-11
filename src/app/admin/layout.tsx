import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { Shell } from "@/components/ui";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const isAdmin = user.role === "FACILITY_ADMIN";
  const nav = [
    { href: "/admin", label: "Overview", icon: "overview", section: "Operations" },
    { href: "/admin/bookings", label: "Bookings", icon: "bookings", section: "Operations" },
    { href: "/admin/customers", label: "Customers", icon: "customers", section: "Operations" },
    { href: "/admin/equipment", label: "Equipment", icon: "equipment", section: "Operations" },
    ...(isAdmin
      ? [
          { href: "/admin/usage", label: "Usage review", icon: "usage", section: "Billing" },
          { href: "/admin/invoices", label: "Invoices", icon: "invoices", section: "Billing" },
          { href: "/admin/automation", label: "Automation", icon: "automation", section: "Billing" },
          { href: "/admin/settings", label: "Settings", icon: "settings", section: "Facility" },
        ]
      : []),
  ];
  return (
    <Shell brand={s.facilityName} nav={nav} user={{ name: user.name, subtitle: isAdmin ? "Facility admin" : "Facility staff" }}>
      {children}
    </Shell>
  );
}
