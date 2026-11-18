import { cn } from "@/lib/utils";

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...p} className={cn("mb-1.5 block text-sm font-semibold text-ink", className)} />;
}

export const inputClass =
  "h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-base text-ink placeholder:text-zinc-400 transition focus:border-pitch-600 focus:outline-none focus:ring-4 focus:ring-flood/40 disabled:bg-zinc-100 aria-[invalid=true]:border-ember";

export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(inputClass, className)} />;
}

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cn(inputClass, "pr-3", className)} />;
}

export function FieldError({ id, children }: { id?: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm font-medium text-[#c2331a]">
      {children}
    </p>
  );
}

export function Alert({ tone = "error", children, className }: { tone?: "error" | "info" | "success" | "warn"; children: React.ReactNode; className?: string }) {
  const tones = {
    error: "border-[#f3b4a5] bg-[#fff1ed] text-[#8a2410]",
    info: "border-sky-200 bg-sky-50 text-sky-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("rounded-xl border px-4 py-3 text-sm font-medium", tones[tone], className)}>
      {children}
    </div>
  );
}
