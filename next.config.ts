import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  // Lets the e2e suite build into its own folder while a dev server is running.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "bcryptjs"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      // Gallery uploads with STORAGE_PROVIDER=supabase (public bucket URLs).
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
    formats: ["image/avif", "image/webp"],
  },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // Security headers on every response (the per-page CSP with a nonce is added in proxy.ts). [SEC-21]
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=(), payment=(self \"https://api.razorpay.com\")" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
    ];
    return [
      { source: "/(.*)", headers: common },
      { source: "/api/((?!files/).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/admin/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
