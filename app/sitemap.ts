import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const pages = ["", "/book", "/gallery", "/my-bookings", "/contact", "/refund-policy", "/terms", "/privacy"];
  return pages.map((p) => ({ url: `${base}${p}`, changeFrequency: p === "" || p === "/book" ? "daily" : "monthly", priority: p === "" ? 1 : p === "/book" ? 0.9 : 0.5 }));
}
