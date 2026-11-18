import "server-only";
import { handle } from "@/lib/errors";
import { requireAdminApi, type AdminContext } from "@/lib/auth/admin";
import type { AdminRole } from "@/db/schema";

/** Wraps an /api/admin handler with auth, role + CSRF checks and JSON error handling. */
export function adminRoute<P = Record<string, string>>(minRole: AdminRole, fn: (req: Request, ctx: AdminContext, params: P) => Promise<Response>) {
  return handle(async (req: Request, routeCtx?: { params: Promise<P> }) => {
    const ctx = await requireAdminApi(req, minRole);
    const params = (routeCtx?.params ? await routeCtx.params : {}) as P;
    return fn(req, ctx, params);
  });
}
