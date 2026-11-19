"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi } from "@/lib/admin/client";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/field";
import { cn } from "@/lib/utils";

type Img = { id: string; url: string; alt: string; category: "CRICKET" | "PICKLEBALL" | "FACILITIES"; isFeatured: boolean };

export function GalleryManager({ images: initial }: { images: Img[] }) {
  const router = useRouter();
  const [images, setImages] = useState(initial);
  useEffect(() => setImages(initial), [initial]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [category, setCategory] = useState<Img["category"]>("CRICKET");
  const [uploading, setUploading] = useState(false);

  const persistOrder = async (list: Img[]) => {
    setSaving(true);
    try {
      await adminApi("/api/admin/gallery", { method: "PUT", json: { ids: list.map((i) => i.id) } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = images.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    const next = [...images];
    [next[i], next[j]] = [next[j], next[i]];
    setImages(next);
    void persistOrder(next);
  };

  const update = async (id: string, patch: Partial<Img>) => {
    setError(null);
    setImages((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await adminApi("/api/admin/gallery", { method: "PATCH", json: { id, ...patch } });
    } catch (e) {
      setError((e as Error).message);
      router.refresh();
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this photo?")) return;
    try {
      await adminApi(`/api/admin/gallery?id=${id}`, { method: "DELETE" });
      setImages((l) => l.filter((x) => x.id !== id));
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("alt", alt);
      fd.set("category", category);
      await adminApi("/api/admin/gallery", { method: "POST", body: fd });
      setFile(null);
      setAlt("");
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={upload} className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:grid-cols-[1fr_1fr_160px_auto] sm:items-end sm:p-5">
        <div>
          <Label htmlFor="g-file">Photo (JPG, PNG, WebP · max 4 MB)</Label>
          <input id="g-file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="min-h-11 py-1 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-sm file:font-bold file:text-white" />
        </div>
        <div>
          <Label htmlFor="g-alt">Alt text (describe the photo)</Label>
          <Input id="g-alt" value={alt} onChange={(e) => setAlt(e.target.value)} required minLength={3} maxLength={160} className="h-10" />
        </div>
        <div>
          <Label htmlFor="g-cat">Category</Label>
          <Select id="g-cat" value={category} onChange={(e) => setCategory(e.target.value as Img["category"])} className="h-10 text-sm">
            <option value="CRICKET">Cricket</option>
            <option value="PICKLEBALL">Pickleball</option>
            <option value="FACILITIES">Facilities</option>
          </Select>
        </div>
        <Button type="submit" variant="dark" className="h-10" loading={uploading}>Upload</Button>
      </form>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-zinc-500">Drag photos to reorder (or use the arrows). Featured photos appear on the home page (first 6). {saving && "Saving order…"}</p>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {images.map((img, i) => (
          <li
            key={img.id}
            draggable
            onDragStart={() => setDragId(img.id)}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragId || dragId === img.id) return;
              const from = images.findIndex((x) => x.id === dragId);
              const next = [...images];
              const [m] = next.splice(from, 1);
              next.splice(i, 0, m);
              setImages(next);
            }}
            onDragEnd={() => {
              setDragId(null);
              void persistOrder(images);
            }}
            className={cn("overflow-hidden rounded-2xl border border-zinc-200 bg-white", dragId === img.id && "opacity-50 ring-2 ring-pitch-600")}
          >
            <div className="relative aspect-[16/10] cursor-grab bg-zinc-100">
              <Image src={img.url} alt={img.alt} fill sizes="(min-width:1280px) 33vw, (min-width:640px) 50vw, 100vw" className="object-cover" />
              <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs font-bold text-white">#{i + 1}</span>
            </div>
            <div className="space-y-2 p-3">
              <Input aria-label="Alt text" defaultValue={img.alt} onBlur={(e) => e.target.value !== img.alt && update(img.id, { alt: e.target.value })} className="h-9 text-sm" />
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="Category" value={img.category} onChange={(e) => update(img.id, { category: e.target.value as Img["category"] })} className="h-9 w-36 text-xs">
                  <option value="CRICKET">Cricket</option>
                  <option value="PICKLEBALL">Pickleball</option>
                  <option value="FACILITIES">Facilities</option>
                </Select>
                <label className="flex min-h-11 items-center gap-2 text-xs font-semibold md:min-h-0"><input type="checkbox" className="h-5 w-5" checked={img.isFeatured} onChange={(e) => update(img.id, { isFeatured: e.target.checked })} />Featured</label>
                <span className="ml-auto flex gap-1">
                  <button type="button" aria-label="Move earlier" onClick={() => move(img.id, -1)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-zinc-300 px-2 text-sm md:min-h-0 md:min-w-0">↑</button>
                  <button type="button" aria-label="Move later" onClick={() => move(img.id, 1)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-zinc-300 px-2 text-sm md:min-h-0 md:min-w-0">↓</button>
                  <button type="button" onClick={() => remove(img.id)} className="inline-flex min-h-11 items-center rounded border border-red-300 px-3 text-xs font-bold text-red-700 md:min-h-0">Delete</button>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
