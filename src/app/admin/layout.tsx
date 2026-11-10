import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { Shell } from "@/components/ui";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const isAdmin = user.role === "FACILITY_ADMIN";
  const nav = [
    { href: "/admin", label: "Overview" },
    { href: "/admin/bookings", label: "Bookings" },
    { href: "/admin/customers", label: "Customers" },
    { href: "/admin/equipment", label: "Equipment" },
    ...(isAdmin
      ? [
          { href: "/admin/usage", label: "Usage review" },
          { href: "/admin/invoices", label: "Invoices" },
          { href: "/admin/automation", label: "Automation" },
          { href: "/admin/settings", label: "Settings" },
        ]
      : []),
  ];
  return (
    <Shell brand={`${s.facilityName} · Admin`} nav={nav} user={{ name: user.name, subtitle: isAdmin ? "Facility admin" : "Facility staff" }}>
      {children}
    </Shell>
  );
}
