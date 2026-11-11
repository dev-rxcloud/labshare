import Link from "next/link";
import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { centsField, errMsg, flash, int, str } from "@/lib/actions";
import { money } from "@/lib/format";
import { Badge, Card, Flash, PageHeader, StatusBadge } from "@/components/ui";

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(["FACILITY_ADMIN"]);
  try {
    switch (str(fd, "op")) {
      case "create": {
        const categoryName = str(fd, "category");
        const category = await prisma.equipmentCategory.upsert({ where: { name: categoryName }, update: {}, create: { name: categoryName } });
        const e = await prisma.equipment.create({
          data: { name: str(fd, "name"), assetTag: str(fd, "assetTag"), categoryId: category.id, location: str(fd, "location") || null, hourlyRateCents: centsField(fd, "rate"), minTierLevel: int(fd, "minTierLevel", 1) },
        });
        await audit(user.id, "equipment.create", "Equipment", e.id);
        flash(`/admin/equipment/${e.id}`, "ok", "Equipment added. Configure booking rules below.");
        break;
      }
      case "tier": {
        const data = { name: str(fd, "name"), level: int(fd, "level", 1), discountPercent: Number(str(fd, "discount") || 0), description: str(fd, "description") || null };
        if (!(data.discountPercent >= 0 && data.discountPercent <= 100)) throw new Error("Discount must be 0–100%.");
        const tid = str(fd, "tierId");
        if (tid) await prisma.pricingTier.update({ where: { id: tid }, data });
        else await prisma.pricingTier.create({ data });
        await audit(user.id, "tier.save", "PricingTier", tid || undefined, data);
        flash("/admin/equipment", "ok", "Plan saved.");
      }
    }
  } catch (e) {
    flash("/admin/equipment", "error", errMsg(e));
  }
}

export default async function EquipmentAdmin({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const sp = await searchParams;
  const [equipment, tiers] = await Promise.all([
    prisma.equipment.findMany({ include: { category: true, _count: { select: { grants: true, certifications: true } } }, orderBy: [{ category: { name: "asc" } }, { name: "asc" }] }),
    prisma.pricingTier.findMany({ orderBy: { level: "asc" }, include: { _count: { select: { customers: true } } } }),
  ]);
  const isAdmin = user.role === "FACILITY_ADMIN";
  return (
    <>
      <PageHeader title="Equipment & plans" />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Equipment">
          <table className="table">
            <thead><tr><th>Name</th><th>Category</th><th className="text-right">Rate</th><th>Access</th><th>Status</th></tr></thead>
            <tbody>
              {equipment.map((e) => (
                <tr key={e.id}>
                  <td><Link className="link" href={`/admin/equipment/${e.id}`}>{e.name}</Link><div className="text-xs text-deep-blue">{e.assetTag} · {e.location}</div></td>
                  <td>{e.category.name}</td>
                  <td className="text-right tabular-nums">{money(e.hourlyRateCents, s.currency)}/h</td>
                  <td className="space-x-1">
                    {e.restricted ? <Badge tone="urgent">grant only ({e._count.grants})</Badge> : <Badge>level {e.minTierLevel}+</Badge>}
                    {e.requiresCertification && <Badge tone="info">cert ({e._count.certifications})</Badge>}
                    {e.requiresApproval && <Badge tone="live">approval</Badge>}
                  </td>
                  <td><StatusBadge status={e.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-6">
          <Card title="Plans (customer tiers)">
            <p className="mb-3 text-xs text-deep-blue">A plan's level decides which equipment its customers can book (equipment "level N+"). Its discount applies to usage on the invoice.</p>
            <div className="space-y-3">
              {[...tiers, null].map((t) => (
                <form key={t?.id ?? "new"} action={act} className="grid grid-cols-6 gap-1 rounded border border-canvas p-2">
                  <input type="hidden" name="op" value="tier" />
                  <input type="hidden" name="tierId" value={t?.id ?? ""} />
                  <input className="input col-span-3" name="name" defaultValue={t?.name} placeholder="New plan" required disabled={!isAdmin} />
                  <input className="input" name="level" type="number" defaultValue={t?.level ?? 1} title="Level" disabled={!isAdmin} />
                  <input className="input col-span-2" name="discount" defaultValue={t ? Number(t.discountPercent) : 0} title="Discount %" disabled={!isAdmin} />
                  <input className="input col-span-4" name="description" defaultValue={t?.description ?? ""} placeholder="Description" disabled={!isAdmin} />
                  {isAdmin && <button className="btn-secondary col-span-2">{t ? "Save" : "Add"}</button>}
                  {t && <div className="col-span-6 text-xs text-deep-blue">{t._count.customers} customer(s)</div>}
                </form>
              ))}
            </div>
          </Card>
          {isAdmin && (
            <Card title="Add equipment">
              <form action={act} className="space-y-3">
                <input type="hidden" name="op" value="create" />
                <div><label className="label">Name</label><input className="input" name="name" required /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label">Asset tag</label><input className="input" name="assetTag" required /></div>
                  <div><label className="label">Category</label><input className="input" name="category" list="cats" required /></div>
                </div>
                <datalist id="cats">{[...new Set(equipment.map((e) => e.category.name))].map((c) => <option key={c} value={c} />)}</datalist>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-1"><label className="label">Rate/h</label><input className="input" name="rate" required /></div>
                  <div className="col-span-1"><label className="label">Min level</label><input className="input" name="minTierLevel" type="number" defaultValue={1} /></div>
                  <div className="col-span-1"><label className="label">Location</label><input className="input" name="location" /></div>
                </div>
                <button className="btn-primary w-full">Add</button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
