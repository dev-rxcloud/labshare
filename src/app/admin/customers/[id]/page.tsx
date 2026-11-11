import Link from "next/link";
import { notFound } from "next/navigation";
import type { CustomerStatus } from "@prisma/client";
import { FACILITY_ROLES, hashPassword, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { maybeReinstate } from "@/lib/services/invoicing";
import { fromLocal } from "@/lib/domain/time";
import { centsField, errMsg, flash, str } from "@/lib/actions";
import { fmtDate, money } from "@/lib/format";
import { Badge, Card, Flash, PageHeader, StatusBadge } from "@/components/ui";

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(FACILITY_ROLES);
  const id = str(fd, "customerId");
  const back = `/admin/customers/${id}`;
  const action = str(fd, "op");
  const adminOnly = ["update", "grant", "revoke-grant", "rate", "remove-rate", "add-user"];
  try {
    if (adminOnly.includes(action) && user.role !== "FACILITY_ADMIN") throw new Error("Only facility admins can change commercial settings.");
    switch (action) {
      case "update": {
        const status = str(fd, "status") as CustomerStatus;
        const before = await prisma.customer.findUniqueOrThrow({ where: { id } });
        const quota = str(fd, "quota");
        const terms = str(fd, "terms");
        await prisma.customer.update({
          where: { id },
          data: {
            name: str(fd, "name"),
            billingEmail: str(fd, "billingEmail"),
            billingAddress: str(fd, "billingAddress") || null,
            taxId: str(fd, "taxId") || null,
            tierId: str(fd, "tierId"),
            status,
            suspendedReason: status === "SUSPENDED" ? (before.status === "SUSPENDED" ? before.suspendedReason : `MANUAL: ${str(fd, "notes") || "suspended by facility"}`) : null,
            officeSuite: str(fd, "officeSuite") || null,
            monthlyOfficeRentCents: centsField(fd, "rent"),
            monthlyHourQuota: quota ? Number(quota) : null,
            paymentTermsDays: terms ? Number(terms) : null,
            notes: str(fd, "notes") || null,
          },
        });
        await audit(user.id, "customer.update", "Customer", id, { status });
        break;
      }
      case "grant":
        await prisma.equipmentGrant.create({ data: { customerId: id, equipmentId: str(fd, "equipmentId") } });
        await audit(user.id, "grant.create", "Customer", id, { equipmentId: str(fd, "equipmentId") });
        break;
      case "revoke-grant":
        await prisma.equipmentGrant.delete({ where: { id: str(fd, "grantId") } });
        await audit(user.id, "grant.delete", "Customer", id);
        break;
      case "rate":
        await prisma.customerEquipmentRate.upsert({
          where: { customerId_equipmentId: { customerId: id, equipmentId: str(fd, "equipmentId") } },
          update: { hourlyRateCents: centsField(fd, "rate") },
          create: { customerId: id, equipmentId: str(fd, "equipmentId"), hourlyRateCents: centsField(fd, "rate") },
        });
        await audit(user.id, "rate.set", "Customer", id, { equipmentId: str(fd, "equipmentId") });
        break;
      case "remove-rate":
        await prisma.customerEquipmentRate.delete({ where: { id: str(fd, "rateId") } });
        break;
      case "cert": {
        const userId = str(fd, "userId");
        const member = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (member.customerId !== id) throw new Error("User is not in this organisation.");
        const exp = str(fd, "expiresAt");
        const expiresAt = exp ? fromLocal(exp, "23:59", (await getSettings()).timezone) : null;
        await prisma.userCertification.upsert({
          where: { userId_equipmentId: { userId, equipmentId: str(fd, "equipmentId") } },
          update: { expiresAt, grantedAt: new Date() },
          create: { userId, equipmentId: str(fd, "equipmentId"), expiresAt },
        });
        await audit(user.id, "certification.grant", "User", userId, { equipmentId: str(fd, "equipmentId") });
        break;
      }
      case "revoke-cert":
        await prisma.userCertification.delete({ where: { id: str(fd, "certId") } });
        await audit(user.id, "certification.revoke", "Customer", id);
        break;
      case "add-user": {
        const email = str(fd, "email").toLowerCase();
        if (str(fd, "password").length < 8) throw new Error("Temporary password must be at least 8 characters.");
        await prisma.user.create({
          data: { email, name: str(fd, "name"), role: str(fd, "role") === "CUSTOMER_ADMIN" ? "CUSTOMER_ADMIN" : "CUSTOMER_MEMBER", customerId: id, passwordHash: await hashPassword(str(fd, "password")) },
        });
        break;
      }
      case "reinstate-check":
        if (!(await maybeReinstate(id, user.id))) throw new Error("Customer still has overdue invoices or was suspended manually.");
        break;
    }
    flash(back, "ok", "Saved.");
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function CustomerDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const viewer = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const sp = await searchParams;
  const { id } = await params;
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      tier: true,
      users: { include: { certifications: { include: { equipment: true } } }, orderBy: { name: "asc" } },
      grants: { include: { equipment: true } },
      rateOverrides: { include: { equipment: true } },
      invoices: { orderBy: { period: "desc" }, take: 12 },
    },
  });
  if (!customer) notFound();
  const [tiers, equipment] = await Promise.all([prisma.pricingTier.findMany({ orderBy: { level: "asc" } }), prisma.equipment.findMany({ where: { status: { not: "RETIRED" } }, orderBy: { name: "asc" } })]);
  const isAdmin = viewer.role === "FACILITY_ADMIN";
  const hidden = <input type="hidden" name="customerId" value={customer.id} />;
  const accessible = equipment.filter((e) => customer.grants.some((g) => g.equipmentId === e.id) || (!e.restricted && customer.tier.level >= e.minTierLevel));

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={<><StatusBadge status={customer.status} /> {customer.suspendedReason && <span className="ml-2 font-bold text-deep-blue">{customer.suspendedReason}</span>}</>}
        actions={<><Link className="btn-secondary" href={`/admin/usage/${customer.id}`}>Usage</Link><Link className="btn-secondary" href={`/admin/bookings?customerId=${customer.id}`}>Bookings</Link></>}
      />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Account & billing">
          <form action={act} className="space-y-3">
            {hidden}
            <input type="hidden" name="op" value="update" />
            <fieldset disabled={!isAdmin} className="space-y-3">
              <div><label className="label">Name</label><input className="input" name="name" defaultValue={customer.name} required /></div>
              <div><label className="label">Billing email</label><input className="input" name="billingEmail" type="email" defaultValue={customer.billingEmail} required /></div>
              <div><label className="label">Billing address</label><textarea className="input" name="billingAddress" rows={2} defaultValue={customer.billingAddress ?? ""} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Tax ID</label><input className="input" name="taxId" defaultValue={customer.taxId ?? ""} /></div>
                <div>
                  <label className="label">Status</label>
                  <select className="input" name="status" defaultValue={customer.status}>{["PENDING", "ACTIVE", "SUSPENDED", "CLOSED"].map((x) => <option key={x}>{x}</option>)}</select>
                </div>
              </div>
              <div>
                <label className="label">Plan</label>
                <select className="input" name="tierId" defaultValue={customer.tierId}>{tiers.map((t) => <option key={t.id} value={t.id}>{t.name} (level {t.level}, {Number(t.discountPercent)}% off)</option>)}</select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Office suite</label><input className="input" name="officeSuite" defaultValue={customer.officeSuite ?? ""} /></div>
                <div><label className="label">Rent / month</label><input className="input" name="rent" defaultValue={(customer.monthlyOfficeRentCents / 100).toFixed(2)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Hour quota / month</label><input className="input" name="quota" type="number" defaultValue={customer.monthlyHourQuota ?? ""} placeholder="none" /></div>
                <div><label className="label">Payment terms (days)</label><input className="input" name="terms" type="number" defaultValue={customer.paymentTermsDays ?? ""} placeholder={`default ${s.paymentTermsDays}`} /></div>
              </div>
              <div><label className="label">Internal notes</label><textarea className="input" name="notes" rows={2} defaultValue={customer.notes ?? ""} /></div>
              {isAdmin && <button className="btn-primary w-full">Save</button>}
            </fieldset>
          </form>
          {customer.status === "SUSPENDED" && customer.suspendedReason?.startsWith("AUTO:") && (
            <form action={act} className="mt-3">{hidden}<button name="op" value="reinstate-check" className="btn-secondary w-full">Re-check overdue status</button></form>
          )}
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card title="People & certifications">
            <table className="table">
              <thead><tr><th>User</th><th>Certifications</th></tr></thead>
              <tbody>
                {customer.users.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "italic"}>
                    <td>{u.name}<div className="text-xs text-deep-blue">{u.email} · {u.role === "CUSTOMER_ADMIN" ? "admin" : "member"}</div></td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {u.certifications.map((c) => (
                          <form action={act} key={c.id} className="inline">
                            {hidden}<input type="hidden" name="certId" value={c.id} />
                            <button name="op" value="revoke-cert" title="Revoke">
                              <Badge tone={c.expiresAt && c.expiresAt < new Date() ? "urgent" : "good"}>{c.equipment.name}{c.expiresAt ? ` · ${fmtDate(c.expiresAt, s.timezone)}` : ""} ×</Badge>
                            </button>
                          </form>
                        ))}
                      </div>
                      <form action={act} className="mt-2 flex flex-wrap gap-1">
                        {hidden}<input type="hidden" name="userId" value={u.id} />
                        <select className="input w-auto" name="equipmentId">{equipment.filter((e) => e.requiresCertification).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                        <input className="input w-auto" type="date" name="expiresAt" title="Expiry (optional)" />
                        <button name="op" value="cert" className="btn-secondary">Certify</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isAdmin && (
              <form action={act} className="mt-4 grid gap-2 border-t border-secondary-grey pt-4 sm:grid-cols-5">
                {hidden}
                <input className="input" name="name" placeholder="Name" required />
                <input className="input" name="email" type="email" placeholder="Email" required />
                <input className="input" name="password" placeholder="Temp password" minLength={8} required />
                <select className="input" name="role"><option value="CUSTOMER_MEMBER">Member</option><option value="CUSTOMER_ADMIN">Admin</option></select>
                <button name="op" value="add-user" className="btn-secondary">Add user</button>
              </form>
            )}
          </Card>

          <Card title="Equipment access">
            <p className="mb-3 text-sm text-deep-blue">
              The {customer.tier.name} plan (level {customer.tier.level}) gives access to {accessible.length} of {equipment.length} instruments. Grants unlock restricted or higher-level equipment for this customer only.
            </p>
            <div className="mb-3 flex flex-wrap gap-1">
              {customer.grants.map((g) => (
                <form action={act} key={g.id}>{hidden}<input type="hidden" name="grantId" value={g.id} /><button name="op" value="revoke-grant" disabled={!isAdmin}><Badge tone="live">{g.equipment.name} ×</Badge></button></form>
              ))}
            </div>
            {isAdmin && (
              <form action={act} className="flex gap-2">
                {hidden}
                <select className="input" name="equipmentId">{equipment.filter((e) => !customer.grants.some((g) => g.equipmentId === e.id)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.restricted ? " (restricted)" : ` (level ${e.minTierLevel})`}</option>)}</select>
                <button name="op" value="grant" className="btn-secondary">Grant</button>
              </form>
            )}
          </Card>

          <Card title="Negotiated rates">
            <ul className="mb-3 space-y-1 text-sm">
              {customer.rateOverrides.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>{r.equipment.name}: <span className="tabular-nums">{money(r.hourlyRateCents, s.currency)}/h</span> <span className="text-xs text-deep-blue">(list {money(r.equipment.hourlyRateCents, s.currency)})</span></span>
                  {isAdmin && <form action={act}>{hidden}<input type="hidden" name="rateId" value={r.id} /><button name="op" value="remove-rate" className="text-xs font-bold text-deep-blue">remove</button></form>}
                </li>
              ))}
              {customer.rateOverrides.length === 0 && <li className="text-deep-blue">List prices apply.</li>}
            </ul>
            {isAdmin && (
              <form action={act} className="flex gap-2">
                {hidden}
                <select className="input" name="equipmentId">{equipment.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                <input className="input w-32" name="rate" placeholder="$/hour" required />
                <button name="op" value="rate" className="btn-secondary">Set rate</button>
              </form>
            )}
            <p className="mt-2 text-xs text-deep-blue">Rates are captured on each booking at the time it is made.</p>
          </Card>

          {isAdmin && (
            <Card title="Invoices">
              <table className="table">
                <tbody>
                  {customer.invoices.map((i) => (
                    <tr key={i.id}>
                      <td><Link className="link font-mono" href={`/admin/invoices/${i.id}`}>{i.number}</Link></td>
                      <td>{i.period}</td>
                      <td className="text-right tabular-nums">{money(i.totalCents, i.currency)}</td>
                      <td><StatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
