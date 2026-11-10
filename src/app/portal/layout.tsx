import { requireCustomerUser } from "@/lib/auth";
import { Shell } from "@/components/ui";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCustomerUser();
  const isAdmin = user.role === "CUSTOMER_ADMIN";
  const nav = [
    { href: "/portal", label: "Dashboard" },
    { href: "/portal/equipment", label: "Book equipment" },
    { href: "/portal/bookings", label: "Bookings" },
    ...(isAdmin ? [{ href: "/portal/usage", label: "Usage" }, { href: "/portal/invoices", label: "Invoices" }, { href: "/portal/team", label: "Team" }] : []),
  ];
  return (
    <Shell brand="LabShare" nav={nav} user={{ name: user.name, subtitle: `${user.customer.name} · ${isAdmin ? "Admin" : "Member"}` }}>
      {user.customer.status !== "ACTIVE" && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {user.customer.status === "SUSPENDED"
            ? "Your organisation's account is suspended, so new bookings are blocked. If this is due to an overdue invoice, access is restored automatically once it is paid."
            : "Your organisation's account is awaiting activation by the facility."}
        </div>
      )}
      {children}
    </Shell>
  );
}
