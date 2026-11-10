import { redirect } from "next/navigation";
import { currentUser, isFacility } from "@/lib/auth";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  redirect(isFacility(user) ? "/admin" : "/portal");
}
