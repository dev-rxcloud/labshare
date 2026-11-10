import { redirect } from "next/navigation";
import { requireCustomerUser, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { errMsg, flash, str } from "@/lib/actions";
import { getSettings } from "@/lib/settings";
import { fmtDate } from "@/lib/format";
import { Badge, Card, Flash, PageHeader } from "@/components/ui";

async function addMember(fd: FormData) {
  "use server";
  const admin = await requireCustomerUser();
  if (admin.role !== "CUSTOMER_ADMIN") redirect("/portal");
  try {
    const email = str(fd, "email").toLowerCase();
    const password = str(fd, "password");
    if (password.length < 8) throw new Error("Temporary password must be at least 8 characters.");
    if (await prisma.user.findUnique({ where: { email } })) throw new Error("A user with that email already exists.");
    const u = await prisma.user.create({
      data: { email, name: str(fd, "name"), role: str(fd, "role") === "CUSTOMER_ADMIN" ? "CUSTOMER_ADMIN" : "CUSTOMER_MEMBER", customerId: admin.customer.id, passwordHash: await hashPassword(password) },
    });
    await audit(admin.id, "user.create", "User", u.id);
    flash("/portal/team", "ok", `Added ${u.name}. Share the temporary password with them securely.`);
  } catch (e) {
    flash("/portal/team", "error", errMsg(e));
  }
}

async function toggleMember(fd: FormData) {
  "use server";
  const admin = await requireCustomerUser();
  if (admin.role !== "CUSTOMER_ADMIN") redirect("/portal");
  const u = await prisma.user.findUnique({ where: { id: str(fd, "id") } });
  if (!u || u.customerId !== admin.customer.id || u.id === admin.id) flash("/portal/team", "error", "Not allowed.");
  await prisma.user.update({ where: { id: u!.id }, data: { active: !u!.active } });
  await audit(admin.id, u!.active ? "user.deactivate" : "user.activate", "User", u!.id);
  flash("/portal/team", "ok", "Updated.");
}

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const user = await requireCustomerUser();
  if (user.role !== "CUSTOMER_ADMIN") redirect("/portal");
  const s = await getSettings();
  const sp = await searchParams;
  const members = await prisma.user.findMany({
    where: { customerId: user.customer.id },
    include: { certifications: { include: { equipment: true } } },
    orderBy: { name: "asc" },
  });
  return (
    <>
      <PageHeader title="Team" subtitle="People in your organisation who can book equipment. Equipment training/certifications are granted by facility staff." />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Members">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Certifications</th><th /></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className={m.active ? "" : "opacity-50"}>
                  <td>{m.name}<div className="text-xs text-slate-500">{m.email}</div></td>
                  <td>{m.role === "CUSTOMER_ADMIN" ? "Admin" : "Member"}</td>
                  <td className="space-x-1">
                    {m.certifications.map((c) => (
                      <Badge key={c.id} tone={c.expiresAt && c.expiresAt < new Date() ? "red" : "green"}>
                        {c.equipment.name}{c.expiresAt ? ` · until ${fmtDate(c.expiresAt, s.timezone)}` : ""}
                      </Badge>
                    ))}
                  </td>
                  <td className="text-right">
                    {m.id !== user.id && (
                      <form action={toggleMember}>
                        <input type="hidden" name="id" value={m.id} />
                        <button className={m.active ? "btn-danger" : "btn-secondary"}>{m.active ? "Deactivate" : "Reactivate"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Add a member">
          <form action={addMember} className="space-y-3">
            <div><label className="label">Name</label><input className="input" name="name" required /></div>
            <div><label className="label">Email</label><input className="input" type="email" name="email" required /></div>
            <div><label className="label">Temporary password</label><input className="input" name="password" minLength={8} required /></div>
            <div>
              <label className="label">Role</label>
              <select className="input" name="role"><option value="CUSTOMER_MEMBER">Member (books equipment)</option><option value="CUSTOMER_ADMIN">Admin (also billing & team)</option></select>
            </div>
            <button className="btn-primary w-full">Add member</button>
          </form>
        </Card>
      </div>
    </>
  );
}
