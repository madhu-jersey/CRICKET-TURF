"use client";

import { api } from "@/lib/utils";

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)bba_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** Admin API call with the CSRF header attached. */
export function adminApi<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}) {
  return api<T>(url, { ...init, headers: { ...(init.headers ?? {}), "x-csrf-token": csrf() } });
}
