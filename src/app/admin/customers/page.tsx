import Link from "next/link";
import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { hashPassword } from "@/lib/auth";
import { centsField, errMsg, flash, str } from "@/lib/actions";
import { money } from "@/lib/format";
import { Card, Flash, PageHeader, StatusBadge } from "@/components/ui";

async function createCustomer(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  try {
    const adminEmail = str(fd, "adminEmail").toLowerCase();
    const password = str(fd, "adminPassword");
    if (password.length < 8) throw new Error("Temporary password must be at least 8 characters.");
    if (await prisma.user.findUnique({ where: { email: adminEmail } })) throw new Error("A user with that email already exists.");
    const c = await prisma.customer.create({
      data: {
        name: str(fd, "name"),
        billingEmail: str(fd, "billingEmail"),
        tierId: str(fd, "tierId"),
        status: "ACTIVE",
        officeSuite: str(fd, "officeSuite") || null,
        monthlyOfficeRentCents: centsField(fd, "rent"),
        users: { create: { email: adminEmail, name: str(fd, "adminName"), role: "CUSTOMER_ADMIN", passwordHash: await hashPassword(password) } },
      },
    });
    await audit(user.id, "customer.create", "Customer", c.id);
    flash(`/admin/customers/${c.id}`, "ok", "Customer created. Share the admin's temporary password securely.");
  } catch (e) {
    flash("/admin/customers", "error", errMsg(e));
  }
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const sp = await searchParams;
  const [customers, tiers] = await Promise.all([
    prisma.customer.findMany({
      include: { tier: true, _count: { select: { users: true } }, invoices: { where: { status: "ISSUED" }, select: { totalCents: true, paidCents: true, dueAt: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.pricingTier.findMany({ orderBy: { level: "asc" } }),
  ]);
  const now = new Date();
  return (
    <>
      <PageHeader title="Customers" subtitle={`${customers.length} organisations`} />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <table className="table">
            <thead><tr><th>Organisation</th><th>Plan</th><th>Office</th><th className="text-right">Users</th><th className="text-right">Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {customers.map((c) => {
                const outstanding = c.invoices.reduce((t, i) => t + i.totalCents - i.paidCents, 0);
                const overdue = c.invoices.some((i) => i.dueAt && i.dueAt < now);
                return (
                  <tr key={c.id}>
                    <td><Link className="link" href={`/admin/customers/${c.id}`}>{c.name}</Link><div className="text-xs text-deep-blue">{c.billingEmail}</div></td>
                    <td>{c.tier.name}</td>
                    <td>{c.officeSuite ?? "—"}{c.monthlyOfficeRentCents > 0 && <div className="text-xs text-deep-blue">{money(c.monthlyOfficeRentCents, s.currency)}/mo</div>}</td>
                    <td className="text-right">{c._count.users}</td>
                    <td className={`text-right tabular-nums ${overdue ? "font-bold text-deep-blue" : ""}`}>{money(outstanding, s.currency)}</td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        {user.role === "FACILITY_ADMIN" && (
          <Card title="Onboard a customer">
            <form action={createCustomer} className="space-y-3">
              <div><label className="label">Organisation name</label><input className="input" name="name" required /></div>
              <div><label className="label">Billing email</label><input className="input" type="email" name="billingEmail" required /></div>
              <div>
                <label className="label">Plan</label>
                <select className="input" name="tierId">{tiers.map((t) => <option key={t.id} value={t.id}>{t.name} (level {t.level}, {Number(t.discountPercent)}% off)</option>)}</select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Office suite</label><input className="input" name="officeSuite" /></div>
                <div><label className="label">Rent / month</label><input className="input" name="rent" placeholder="0.00" /></div>
              </div>
              <div className="border-t border-secondary-grey pt-3 text-xs font-medium text-deep-blue">First admin user</div>
              <div><label className="label">Name</label><input className="input" name="adminName" required /></div>
              <div><label className="label">Email</label><input className="input" type="email" name="adminEmail" required /></div>
              <div><label className="label">Temporary password</label><input className="input" name="adminPassword" minLength={8} required /></div>
              <button className="btn-primary w-full">Create customer</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
