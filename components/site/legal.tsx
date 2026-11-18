export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12">
      <h1 className="font-display text-5xl font-extrabold uppercase">{title}</h1>
      <p className="mt-2 text-sm text-haze">Last updated {updated}</p>
      <div className="mt-8 space-y-4 leading-relaxed text-chalk/85 [&_a]:text-flood [&_a]:underline [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:font-bold [&_h2]:uppercase [&_h2]:text-chalk [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-2">
        {children}
      </div>
    </div>
  );
}
