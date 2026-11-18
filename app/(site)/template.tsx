/** Re-mounts on every navigation, giving each public page a soft fade-in. */
export default function SiteTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-[fade_.45s_ease-out_both] motion-reduce:animate-none">{children}</div>;
}
