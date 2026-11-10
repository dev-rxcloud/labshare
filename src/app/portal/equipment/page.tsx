import Link from "next/link";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { checkAccess } from "@/lib/domain/booking-rules";
import { money } from "@/lib/format";
import { Badge, PageHeader } from "@/components/ui";

export default async function EquipmentCatalog() {
  const user = await requireCustomerUser();
  const s = await getSettings();
  const [equipment, grants, certs, rates] = await Promise.all([
    prisma.equipment.findMany({ where: { status: { not: "RETIRED" } }, include: { category: true }, orderBy: [{ category: { name: "asc" } }, { name: "asc" }] }),
    prisma.equipmentGrant.findMany({ where: { customerId: user.customer.id } }),
    prisma.userCertification.findMany({ where: { userId: user.id } }),
    prisma.customerEquipmentRate.findMany({ where: { customerId: user.customer.id } }),
  ]);
  const now = new Date();
  const groups = new Map<string, typeof equipment>();
  for (const e of equipment) groups.set(e.category.name, [...(groups.get(e.category.name) ?? []), e]);
  const discount = Number(user.customer.tier.discountPercent);

  return (
    <>
      <PageHeader title="Equipment" subtitle={`Rates shown are your organisation's rates${discount ? `; your ${user.customer.tier.name} plan discount of ${discount}% is applied on the invoice` : ""}.`} />
      <div className="space-y-8">
        {[...groups].map(([category, items]) => (
          <section key={category}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{category}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((e) => {
                const cert = certs.find((c) => c.equipmentId === e.id);
                const access = checkAccess({
                  user: { id: user.id, active: user.active, role: user.role, customerId: user.customerId },
                  customer: { id: user.customer.id, status: user.customer.status, tierLevel: user.customer.tier.level, monthlyHourQuota: user.customer.monthlyHourQuota },
                  equipment: e,
                  hasGrant: grants.some((g) => g.equipmentId === e.id),
                  certification: cert ? { expiresAt: cert.expiresAt } : null,
                  now,
                });
                const rate = rates.find((r) => r.equipmentId === e.id)?.hourlyRateCents ?? e.hourlyRateCents;
                return (
                  <div key={e.id} className="card flex flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">{e.name}</div>
                        <div className="text-xs text-slate-500">{e.location} · {e.assetTag}</div>
                      </div>
                      <div className="text-right text-sm font-semibold tabular-nums">{money(rate, s.currency)}<span className="text-xs font-normal text-slate-500">/h</span></div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {e.status === "MAINTENANCE" && <Badge tone="amber">maintenance</Badge>}
                      {e.requiresCertification && <Badge tone={cert ? "green" : "gray"}>{cert ? "certified" : "training required"}</Badge>}
                      {e.requiresApproval && <Badge tone="purple">needs approval</Badge>}
                      {e.restricted && <Badge tone="red">restricted</Badge>}
                    </div>
                    <div className="mt-auto pt-4">
                      {access.allowed ? (
                        <Link href={`/portal/equipment/${e.id}`} className="btn-primary w-full">Check availability</Link>
                      ) : (
                        <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">{access.message}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
