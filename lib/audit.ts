import { schema, type Queryable } from "@/db/client";

export async function audit(
  q: Queryable,
  entry: { actor: string; action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown },
) {
  await q.insert(schema.auditLogs).values({
    actor: entry.actor,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : JSON.parse(JSON.stringify(entry.before)),
    after: entry.after === undefined ? null : JSON.parse(JSON.stringify(entry.after)),
  });
}
