import Link from "next/link";
import { requireCustomerUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { cancellationTerms } from "@/lib/domain/booking-rules";
import { addMinutes } from "@/lib/domain/time";
import { cancelBooking, checkIn, checkOut } from "@/lib/services/bookings";
import { errMsg, flash, str } from "@/lib/actions";
import { fmt } from "@/lib/format";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";

async function act(fd: FormData) {
  "use server";
  const user = await requireCustomerUser();
  const id = str(fd, "id");
  const action = str(fd, "action");
  const back = `/portal/bookings${str(fd, "qs")}`;
  try {
    if (action === "cancel") {
      const t = await cancelBooking(user.id, id);
      flash(back, "ok", t.late ? `Cancelled. A late-cancellation fee of ${t.feePercent}% applies.` : "Booking cancelled.");
    }
    if (action === "checkin") await checkIn(user.id, id);
    if (action === "checkout") await checkOut(user.id, id);
    flash(back, "ok", action === "checkin" ? "Checked in. Remember to check out when done." : "Checked out. Thanks!");
  } catch (e) {
    flash(back, "error", errMsg(e));
  }
}

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ scope?: string; view?: string; ok?: string; error?: string }> }) {
  const user = await requireCustomerUser();
  const sp = await searchParams;
  const s = await getSettings();
  const now = new Date();
  const company = sp.scope === "company" && user.role === "CUSTOMER_ADMIN";
  const past = sp.view === "past";
  const bookings = await prisma.booking.findMany({
    where: {
      ...(company ? { customerId: user.customer.id } : { userId: user.id }),
      ...(past ? { endsAt: { lt: now } } : { endsAt: { gte: now } }),
    },
    include: { equipment: true, user: true },
    orderBy: { startsAt: past ? "desc" : "asc" },
    take: 200,
  });
  const qs = `?${new URLSearchParams({ ...(company ? { scope: "company" } : {}), ...(past ? { view: "past" } : {}) })}`;
  const tab = (label: string, params: Record<string, string>, active: boolean) => (
    <Link href={`?${new URLSearchParams(params)}`} className={active ? "btn-primary" : "btn-secondary"}>{label}</Link>
  );

  return (
    <>
      <PageHeader
        title="Bookings"
        actions={
          <>
            {tab("Upcoming", company ? { scope: "company" } : {}, !past)}
            {tab("Past", { ...(company ? { scope: "company" } : {}), view: "past" }, past)}
            {user.role === "CUSTOMER_ADMIN" && tab(company ? "Showing: whole organisation" : "Showing: mine", { ...(company ? {} : { scope: "company" }), ...(past ? { view: "past" } : {}) }, false)}
          </>
        }
      />
      <Flash searchParams={sp} />
      <Card>
        {bookings.length === 0 ? (
          <Empty>No bookings.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Equipment</th><th>When</th>{company && <th>User</th>}<th>Status</th><th>Actual use</th><th /></tr></thead>
            <tbody>
              {bookings.map((b) => {
                const terms = cancellationTerms(b, now, s);
                const canCheckIn = b.status === "CONFIRMED" && now >= addMinutes(b.startsAt, -15) && now < b.endsAt;
                return (
                  <tr key={b.id}>
                    <td>{b.equipment.name}<div className="text-xs text-slate-500">{b.purpose}</div></td>
                    <td className="whitespace-nowrap">{fmt(b.startsAt, s.timezone, "EEE d MMM, HH:mm")}–{fmt(b.endsAt, s.timezone, "HH:mm")}</td>
                    {company && <td>{b.user.name}</td>}
                    <td><StatusBadge status={b.status} />{b.autoClosed && <div className="text-xs text-amber-700">auto checked-out</div>}</td>
                    <td className="text-xs text-slate-600">{b.checkedInAt ? `${fmt(b.checkedInAt, s.timezone, "HH:mm")}–${b.checkedOutAt ? fmt(b.checkedOutAt, s.timezone, "HH:mm") : "…"}` : "—"}</td>
                    <td className="text-right">
                      <form action={act} className="inline-flex gap-1">
                        <input type="hidden" name="id" value={b.id} />
                        <input type="hidden" name="qs" value={qs} />
                        {canCheckIn && <button name="action" value="checkin" className="btn-primary">Check in</button>}
                        {b.status === "CHECKED_IN" && <button name="action" value="checkout" className="btn-primary">Check out</button>}
                        {terms.canCancel && (
                          <button name="action" value="cancel" className="btn-danger" title={terms.late ? `Late cancellation: ${terms.feePercent}% fee` : "Free cancellation"}>
                            Cancel{terms.late ? ` (${terms.feePercent}% fee)` : ""}
                          </button>
                        )}
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
