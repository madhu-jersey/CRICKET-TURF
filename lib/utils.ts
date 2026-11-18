export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type ApiErrorBody = { error?: { code?: string; message?: string } };

/** fetch wrapper for client components: JSON in/out, typed errors, network failures normalised. */
export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", "You seem to be offline. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) throw new ApiError(data.error?.code ?? "INTERNAL", data.error?.message ?? "Something went wrong. Please try again.", res.status);
  return data;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

export function inr(n: number) {
  return "₹" + n.toLocaleString("en-IN");
}
