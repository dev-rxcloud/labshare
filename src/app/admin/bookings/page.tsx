import Link from "next/link";
import type { BookingStatus, Prisma } from "@prisma/client";
import { FACILITY_ROLES, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { staffSetStatus } from "@/lib/services/bookings";
import { addDays, fromLocal, localDateString } from "@/lib/domain/time";
import { errMsg, flash, str } from "@/lib/actions";
import { fmt } from "@/lib/format";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";

const STATUSES: BookingStatus[] = ["PENDING_APPROVAL", "CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"];

async function act(fd: FormData) {
  "use server";
  const user = await requireUser(FACILITY_ROLES);
  const back = `/admin/bookings${str(fd, "qs")}`;
  try {
    await staffSetStatus(user.id, str(fd, "rid"), str(fd, "to") as BookingStatus, str(fd, "note") || undefined);
    flash(back, "ok", "Booking updated.");
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function AdminBookings({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser(FACILITY_ROLES);
  const s = await getSettings();
  const sp = await searchParams;
  const today = localDateString(new Date(), s.timezone);
  const from = sp.from || (sp.status === "PENDING_APPROVAL" ? today : localDateString(addDays(new Date(), -7), s.timezone));
  const to = sp.to || localDateString(addDays(new Date(), 30), s.timezone);
  const where: Prisma.BookingWhereInput = {
    startsAt: { gte: fromLocal(from, "00:00", s.timezone), lt: fromLocal(to, "23:59", s.timezone) },
    ...(sp.status ? { status: sp.status as BookingStatus } : {}),
    ...(sp.customerId ? { customerId: sp.customerId } : {}),
    ...(sp.equipmentId ? { equipmentId: sp.equipmentId } : {}),
  };
  const [bookings, customers, equipment] = await Promise.all([
    prisma.booking.findMany({ where, include: { equipment: true, customer: true, user: true }, orderBy: { startsAt: "asc" }, take: 500 }),
    prisma.customer.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.equipment.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const qs = `?${new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "ok" && k !== "error") as [string, string][])}`;
  const btn = (id: string, to: BookingStatus, label: string, cls = "btn-secondary") => (
    <form action={act} key={to}>
      <input type="hidden" name="rid" value={id} />
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="qs" value={qs} />
      <button className={cls}>{label}</button>
    </form>
  );

  return (
    <>
      <PageHeader title="Bookings" subtitle="Approve requests, record no-shows and fix statuses. Usage times are corrected on the Usage review page." />
      <Flash searchParams={sp} />
      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-6">
        <div><label className="label">From</label><input className="input" type="date" name="from" defaultValue={from} /></div>
        <div><label className="label">To</label><input className="input" type="date" name="to" defaultValue={to} /></div>
        <div>
          <label className="label">Status</label>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>{STATUSES.map((st) => <option key={st} value={st}>{st.replace("_", " ").toLowerCase()}</option>)}</select>
        </div>
        <div>
          <label className="label">Customer</label>
          <select className="input" name="customerId" defaultValue={sp.customerId ?? ""}><option value="">All</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <div>
          <label className="label">Equipment</label>
          <select className="input" name="equipmentId" defaultValue={sp.equipmentId ?? ""}><option value="">All</option>{equipment.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        </div>
        <div className="flex items-end gap-2"><button className="btn-primary">Filter</button><Link href="/admin/bookings" className="btn-secondary">Reset</Link></div>
      </form>
      <Card>
        {bookings.length === 0 ? <Empty>No bookings match.</Empty> : (
          <table className="table">
            <thead><tr><th>When</th><th>Equipment</th><th>Customer / user</th><th>Status</th><th>Actual</th><th /></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">{fmt(b.startsAt, s.timezone, "EEE d MMM HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")}</td>
                  <td>{b.equipment.name}</td>
                  <td>{b.customer.name}<div className="text-xs text-slate-500">{b.user.name}{b.purpose ? ` · ${b.purpose}` : ""}</div></td>
                  <td><StatusBadge status={b.status} />{b.invoiceLineId && <div className="text-xs text-slate-500">invoiced</div>}</td>
                  <td className="text-xs text-slate-600">{b.checkedInAt ? `${fmt(b.checkedInAt, s.timezone, "HH:mm")}–${b.checkedOutAt ? fmt(b.checkedOutAt, s.timezone, "HH:mm") : "…"}` : "—"}</td>
                  <td>
                    {!b.invoiceLineId && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {b.status === "PENDING_APPROVAL" && [btn(b.id, "CONFIRMED", "Approve", "btn-primary"), btn(b.id, "REJECTED", "Decline", "btn-danger")]}
                        {b.status === "CONFIRMED" && [btn(b.id, "CHECKED_IN", "Check in"), btn(b.id, "NO_SHOW", "No-show"), btn(b.id, "CANCELLED", "Cancel", "btn-danger")]}
                        {b.status === "CHECKED_IN" && btn(b.id, "COMPLETED", "Check out")}
                        {b.status === "NO_SHOW" && [btn(b.id, "COMPLETED", "Mark used"), btn(b.id, "CANCELLED", "Waive")]}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
