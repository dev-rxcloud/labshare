import { redirect } from "next/navigation";
import { createSession, currentUser, isFacility, verifyCredentials } from "@/lib/auth";
import { Flash } from "@/components/ui";

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
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold text-brand-700">LabShare</h1>
        <p className="mb-6 text-sm text-slate-500">Book shared lab equipment. Usage-based billing, automated.</p>
        <Flash searchParams={sp} />
        <form action={login} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input className="input" id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          <button className="btn-primary w-full">Sign in</button>
        </form>
        {process.env.NODE_ENV !== "production" && (
          <p className="mt-4 text-xs text-slate-500">
            Demo: admin@facility.test, lead@helixbio.test, scientist@novatx.test — password <code>password123</code>
          </p>
        )}
      </div>
    </div>
  );
}
