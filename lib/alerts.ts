/** Owner security alerts (OTP cap hit, booking floods). Logged to the audit log and sent on WhatsApp once a day per kind. */
import "server-only";
import { getDb } from "@/db/client";
import { getSettings } from "@/lib/booking/data";
import { audit } from "@/lib/audit";
import { enqueueMessage, dispatchInBackground } from "@/lib/messaging";
import { istDateKey } from "@/lib/time";

export async function alertOwner(kind: string, text: string, now = new Date()) {
  try {
    const db = await getDb();
    const settings = await getSettings(db);
    const id = settings.ownerAlertPhone
      ? await enqueueMessage(db, {
          phone: settings.ownerAlertPhone,
          optedIn: true,
          template: "admin_alert",
          params: { text: text.slice(0, 200) },
          // One alert per kind per day, so an attack can't turn into a message flood of its own.
          dedupeKey: `alert:${kind}:${istDateKey(now)}`,
        })
      : null;
    if (id) {
      await audit(db, { actor: "system", action: `security.${kind}`, entity: "Security", after: { text } });
      dispatchInBackground([id]);
    }
  } catch (e) {
    console.error("[alerts] failed", e);
  }
}
