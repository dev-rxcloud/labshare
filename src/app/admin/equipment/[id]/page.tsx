import Link from "next/link";
import { notFound } from "next/navigation";
import type { EquipmentStatus } from "@prisma/client";
import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { fromLocal } from "@/lib/domain/time";
import { ACTIVE_BOOKING_STATUSES, overlaps } from "@/lib/domain/booking-rules";
import { centsField, errMsg, flash, int, str } from "@/lib/actions";
import { fmt } from "@/lib/format";
import { Card, Flash, PageHeader } from "@/components/ui";

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(FACILITY_ROLES);
  const id = str(fd, "equipmentId");
  const back = `/admin/equipment/${id}`;
  try {
    const s = await getSettings();
    switch (str(fd, "op")) {
      case "update": {
        if (user.role !== "FACILITY_ADMIN") throw new Error("Only facility admins can change equipment settings.");
        const data = {
          name: str(fd, "name"),
          description: str(fd, "description") || null,
          location: str(fd, "location") || null,
          status: str(fd, "status") as EquipmentStatus,
          hourlyRateCents: centsField(fd, "rate"),
          billingIncrementMinutes: int(fd, "billingIncrementMinutes", 15),
          minBookingMinutes: int(fd, "minBookingMinutes", 30),
          maxBookingMinutes: int(fd, "maxBookingMinutes", 480),
          bufferMinutes: int(fd, "bufferMinutes"),
          bookableFromHour: int(fd, "bookableFromHour"),
          bookableToHour: int(fd, "bookableToHour", 24),
          minTierLevel: int(fd, "minTierLevel", 1),
          restricted: fd.get("restricted") === "on",
          requiresCertification: fd.get("requiresCertification") === "on",
          requiresApproval: fd.get("requiresApproval") === "on",
        };
        if (data.minBookingMinutes > data.maxBookingMinutes) throw new Error("Minimum booking is longer than maximum.");
        if (!(data.bookableFromHour >= 0 && data.bookableToHour <= 24 && data.bookableFromHour < data.bookableToHour)) throw new Error("Bookable hours must be within 0–24.");
        await prisma.equipment.update({ where: { id }, data });
        await audit(user.id, "equipment.update", "Equipment", id, data);
        break;
      }
      case "maintenance": {
        const startsAt = fromLocal(str(fd, "startDate"), str(fd, "startTime"), s.timezone);
        const endsAt = fromLocal(str(fd, "endDate"), str(fd, "endTime"), s.timezone);
        if (!(endsAt > startsAt)) throw new Error("Maintenance end must be after start.");
        await prisma.maintenanceWindow.create({ data: { equipmentId: id, startsAt, endsAt, reason: str(fd, "reason") || null } });
        await audit(user.id, "maintenance.create", "Equipment", id);
        break;
      }
      case "delete-maintenance":
        await prisma.maintenanceWindow.delete({ where: { id: str(fd, "windowId") } });
        break;
    }
    flash(back, "ok", "Saved.");
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function EquipmentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const sp = await searchParams;
  const { id } = await params;
  const e = await prisma.equipment.findUnique({ where: { id }, include: { category: true, maintenance: { where: { endsAt: { gte: new Date() } }, orderBy: { startsAt: "asc" } } } });
  if (!e) notFound();
  const upcoming = await prisma.booking.findMany({
    where: { equipmentId: id, endsAt: { gte: new Date() }, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
    include: { customer: true, user: true },
    orderBy: { startsAt: "asc" },
    take: 50,
  });
  const isAdmin = user.role === "FACILITY_ADMIN";
  const hidden = <input type="hidden" name="equipmentId" value={e.id} />;
  const num = (label: string, name: keyof typeof e, hint?: string) => (
    <div><label className="label">{label}</label><input className="input" type="number" name={name} defaultValue={String(e[name])} />{hint && <p className="mt-1 text-xs text-deep-blue">{hint}</p>}</div>
  );
  const check = (label: string, name: "restricted" | "requiresCertification" | "requiresApproval", hint: string) => (
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name={name} defaultChecked={e[name]} className="mt-0.5" /><span><span className="font-medium">{label}</span><span className="block text-xs text-deep-blue">{hint}</span></span></label>
  );

  return (
    <>
      <PageHeader title={e.name} subtitle={`${e.category.name} · ${e.assetTag}`} actions={<Link className="btn-secondary" href={`/admin/bookings?equipmentId=${e.id}`}>Bookings</Link>} />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Settings & access rules" className="lg:col-span-2">
          <form action={act}>
            {hidden}
            <input type="hidden" name="op" value="update" />
            <fieldset disabled={!isAdmin} className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2"><label className="label">Name</label><input className="input" name="name" defaultValue={e.name} /></div>
              <div><label className="label">Status</label><select className="input" name="status" defaultValue={e.status}><option>ACTIVE</option><option>MAINTENANCE</option><option>RETIRED</option></select></div>
              <div className="sm:col-span-2"><label className="label">Description</label><input className="input" name="description" defaultValue={e.description ?? ""} /></div>
              <div><label className="label">Location</label><input className="input" name="location" defaultValue={e.location ?? ""} /></div>
              <div><label className="label">Rate per hour</label><input className="input" name="rate" defaultValue={(e.hourlyRateCents / 100).toFixed(2)} /></div>
              {num("Billing increment (min)", "billingIncrementMinutes", "Actual use is rounded up to this.")}
              {num("Cleanup buffer (min)", "bufferMinutes", "Kept free between bookings.")}
              {num("Min booking (min)", "minBookingMinutes")}
              {num("Max booking (min)", "maxBookingMinutes")}
              {num("Minimum plan level", "minTierLevel")}
              {num("Bookable from (hour)", "bookableFromHour", `Facility time (${s.timezone}).`)}
              {num("Bookable until (hour)", "bookableToHour", "24 = midnight.")}
              <div />
              <div className="space-y-2 sm:col-span-3">
                {check("Restricted", "restricted", "Only customers with an explicit grant can book, regardless of plan.")}
                {check("Requires certification", "requiresCertification", "Each user needs a (non-expired) certification granted by staff.")}
                {check("Requires approval", "requiresApproval", "Bookings start as requests; staff approve or decline. Unanswered requests expire.")}
              </div>
              {isAdmin && <div className="sm:col-span-3"><button className="btn-primary">Save</button></div>}
            </fieldset>
          </form>
        </Card>
        <div className="space-y-6">
          <Card title="Maintenance windows">
            <ul className="mb-3 space-y-1 text-sm">
              {e.maintenance.map((m) => {
                const clash = upcoming.filter((b) => overlaps(b.startsAt, b.endsAt, m.startsAt, m.endsAt)).length;
                return (
                  <li key={m.id} className="flex items-start justify-between gap-2">
                    <span>{fmt(m.startsAt, s.timezone)} → {fmt(m.endsAt, s.timezone)}<span className="block text-xs font-medium">{m.reason}{clash ? ` · Check: overlaps ${clash} booking(s)` : ""}</span></span>
                    <form action={act}>{hidden}<input type="hidden" name="windowId" value={m.id} /><button name="op" value="delete-maintenance" className="text-xs font-bold text-deep-blue">remove</button></form>
                  </li>
                );
              })}
              {e.maintenance.length === 0 && <li className="text-deep-blue">None scheduled.</li>}
            </ul>
            <form action={act} className="grid grid-cols-2 gap-2">
              {hidden}
              <input className="input" type="date" name="startDate" required />
              <input className="input" type="time" name="startTime" defaultValue="08:00" required />
              <input className="input" type="date" name="endDate" required />
              <input className="input" type="time" name="endTime" defaultValue="17:00" required />
              <input className="input col-span-2" name="reason" placeholder="Reason (e.g. annual service)" />
              <button name="op" value="maintenance" className="btn-secondary col-span-2">Block time</button>
            </form>
          </Card>
          <Card title="Upcoming bookings">
            <ul className="space-y-1 text-sm">
              {upcoming.map((b) => <li key={b.id}>{fmt(b.startsAt, s.timezone, "EEE d MMM HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")} · {b.customer.name}</li>)}
              {upcoming.length === 0 && <li className="text-deep-blue">None.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
