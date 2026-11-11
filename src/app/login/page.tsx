import { redirect } from "next/navigation";
import { createSession, currentUser, isFacility, verifyCredentials } from "@/lib/auth";
import { CalendarCheck, Gauge, ReceiptText } from "lucide-react";
import { Flash, Logo } from "@/components/ui";

async function login(fd: FormData) {
  "use server";
  const user = await verifyCredentials(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  if (!user) redirect("/login?error=Invalid email or password");
  await createSession(user.id);
  redirect(isFacility(user) ? "/admin" : "/portal");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (user) redirect(isFacility(user) ? "/admin" : "/portal");
  const sp = await searchParams;
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="flex flex-col justify-between bg-deep-blue px-8 py-10 text-canvas sm:px-14 lg:py-14">
        <Logo variant="white" width={240} />
        <div className="my-12 max-w-md">
          <h1 className="font-display text-4xl leading-tight font-bold sm:text-5xl">Shared lab equipment, billed automatically.</h1>
          <ul className="mt-8 space-y-4 text-[15px] font-semibold">
            <li className="flex gap-3"><CalendarCheck size={20} className="mt-0.5 shrink-0" aria-hidden />Book instruments your team is cleared to use.</li>
            <li className="flex gap-3"><Gauge size={20} className="mt-0.5 shrink-0" aria-hidden />Pay for actual use, tracked by check-in and check-out.</li>
            <li className="flex gap-3"><ReceiptText size={20} className="mt-0.5 shrink-0" aria-hidden />Monthly invoices, reminders and receipts without paperwork.</li>
          </ul>
        </div>
        <div className="text-sm font-semibold">LabShare by RxCloud</div>
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold">Sign in</h2>
          <p className="mt-1 mb-8 text-sm font-medium">Use the account your facility or organisation admin created for you.</p>
          <Flash searchParams={sp} />
          <form action={login} className="space-y-5">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input h-11" id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input className="input h-11" id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <button className="btn-primary h-11 w-full">Sign in</button>
          </form>
          {process.env.NODE_ENV !== "production" && (
            <p className="mt-8 rounded-xl border border-secondary-grey p-4 text-xs font-medium leading-relaxed">
              Demo accounts (password <code className="font-bold">password123</code>): admin@facility.test · lead@helixbio.test · scientist@helixbio.test
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
