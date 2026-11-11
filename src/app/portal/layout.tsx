import { requireCustomerUser } from "@/lib/auth";
import { Shell } from "@/components/ui";
import { getSettings } from "@/lib/settings";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCustomerUser();
  const isAdmin = user.role === "CUSTOMER_ADMIN";
  const nav = [
    { href: "/portal", label: "Dashboard", icon: "overview", section: "Lab" },
    { href: "/portal/equipment", label: "Book equipment", icon: "book", section: "Lab" },
    { href: "/portal/bookings", label: "My bookings", icon: "bookings", section: "Lab" },
    ...(isAdmin ? [{ href: "/portal/usage", label: "Usage", icon: "usage", section: "Organisation" }, { href: "/portal/invoices", label: "Invoices", icon: "invoices", section: "Organisation" }, { href: "/portal/team", label: "Team", icon: "team", section: "Organisation" }] : []),
  ];
  return (
    <Shell brand={(await getSettings()).facilityName} nav={nav} user={{ name: user.name, subtitle: `${user.customer.name} · ${isAdmin ? "Admin" : "Member"}` }}>
      {user.customer.status !== "ACTIVE" && (
        <div role="alert" className="notice-problem mb-6">
          {user.customer.status === "SUSPENDED"
            ? "Your organisation's account is suspended, so new bookings are blocked. If this is due to an overdue invoice, access is restored automatically once it is paid."
            : "Your organisation's account is awaiting activation by the facility."}
        </div>
      )}
      {children}
    </Shell>
  );
}
