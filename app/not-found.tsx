import Link from "next/link";

export default function NotFound() {
  return (
    <main className="floodlit grid min-h-dvh place-items-center px-4 text-center text-chalk">
      <div>
        <p className="font-display text-8xl font-extrabold text-flood">404</p>
        <h1 className="mt-2 font-display text-4xl font-bold uppercase">Out of bounds</h1>
        <p className="mt-2 text-mist">That page doesn&apos;t exist.</p>
        <Link href="/" className="mt-6 inline-block rounded-full bg-flood px-6 py-3 font-bold text-flood-ink">Back to home</Link>
      </div>
    </main>
  );
}
