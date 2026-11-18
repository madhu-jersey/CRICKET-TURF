import { ForgotForm } from "@/components/admin/forgot-form";

export const metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <p className="font-display text-sm font-bold uppercase tracking-[0.3em] text-pitch-600">Boundary Box Arena</p>
        <h1 className="mt-1 font-display text-4xl font-extrabold uppercase">Reset password</h1>
        <ForgotForm />
      </div>
    </main>
  );
}
