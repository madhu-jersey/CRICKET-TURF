import Link from "next/link";
import { cn } from "@/lib/utils";

type Variant = "flood" | "ghost" | "outline" | "dark" | "danger" | "light";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  flood: "bg-flood text-flood-ink hover:bg-white shadow-glow disabled:shadow-none",
  ghost: "bg-transparent text-chalk hover:bg-white/10",
  outline: "border border-white/25 text-chalk hover:border-flood hover:text-flood",
  dark: "bg-ink text-white hover:bg-pitch-700",
  danger: "bg-ember text-white hover:bg-[#e2532f]",
  light: "border border-zinc-300 bg-white text-ink hover:border-ink",
};
const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-5 text-[15px]",
  lg: "h-14 px-7 text-base",
};

export function buttonClass(variant: Variant = "flood", size: Size = "md", extra?: string) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-bold tracking-wide transition-[background,color,border,transform] duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 select-none whitespace-nowrap",
    variants[variant],
    sizes[size],
    extra,
  );
}

export function Button({
  variant,
  size,
  className,
  loading,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ variant, size, className, ...props }: React.ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn("size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}
