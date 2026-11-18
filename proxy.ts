/**
 * Per-request Content-Security-Policy with a nonce. Next.js reads the nonce from the request's CSP
 * header and adds it to its own inline scripts, so only scripts we ship (plus Razorpay checkout
 * and Cloudflare Turnstile) can run. [SEC-21]
 */
import { NextResponse, type NextRequest } from "next/server";

export function buildCsp(nonce: string, dev = process.env.NODE_ENV !== "production") {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "https://checkout.razorpay.com", "https://challenges.cloudflare.com", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://images.unsplash.com", "https://*.supabase.co"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com", "https://challenges.cloudflare.com", ...(dev ? ["ws:", "wss:"] : [])],
    "frame-src": ["https://api.razorpay.com", "https://checkout.razorpay.com", "https://www.google.com", "https://maps.google.com", "https://challenges.cloudflare.com"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      // Pages only: API routes return JSON, static assets don't need a nonce.
      source: "/((?!api|_next/static|_next/image|icon.svg|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
