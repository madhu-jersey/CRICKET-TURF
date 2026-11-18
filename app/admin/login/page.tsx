import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/admin";
import { LoginForm } from "@/components/admin/login-form";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getAdminSession()) redirect("/admin");
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <p className="font-display text-sm font-bold uppercase tracking-[0.3em] text-pitch-600">Boundary Box Arena</p>
        <h1 className="mt-1 font-display text-4xl font-extrabold uppercase">Owner login</h1>
        <LoginForm demo={env.demoMode} />
      </div>
    </main>
  );
}
