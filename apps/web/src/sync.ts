import type {
  Product,
  Posted,
  Bootstrap,
} from "../../../packages/contracts/index.ts";
import { db, lease, putMeta, type Outbox } from "./db.ts";
import { api, ApiError, probe, setCsrf } from "./api.ts";
let ongoing: Promise<void> | null = null;
export async function pullCatalogue() {
  const acknowledgedBeforePull = (
    await db.outbox.where("state").equals("ACKED").toArray()
  ).map((o) => o.id);
  const products: Product[] = [];
  let offset: number | null = 0,
    cursor: string | undefined;
  while (offset !== null) {
    const page: {
      items: Product[];
      cursor: string;
      next_offset: number | null;
    } = await api(
      `/sync/catalogue?offset=${offset}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    if (cursor && cursor !== page.cursor)
      throw new ApiError(
        "VERSION_CONFLICT",
        409,
        "Catalogue changed while downloading; retry",
      );
    cursor = page.cursor;
    products.push(...page.items.map(({ cost_minor: _, ...safe }) => safe));
    offset = page.next_offset;
  }
  await db.transaction(
    "rw",
    [db.products, db.meta, db.deltas, db.outbox],
    async () => {
      await db.products.clear();
      await db.products.bulkPut(products);
      await putMeta("catalogue_cursor", cursor);
      await putMeta("catalogue_at", new Date().toISOString());
      // Only ACKs established before this snapshot request are covered by the snapshot.
      for (const id of acknowledgedBeforePull)
        await db.deltas.where("sale").equals(id).delete();
    },
  );
}
async function drain(force: boolean) {
  if (!(await lease()) || !(await probe())) return;
  let user: Bootstrap;
  try {
    user = await api<Bootstrap>("/bootstrap");
    setCsrf(user.csrf_token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401)
      await db.outbox
        .filter((o) => o.state !== "ACKED" && o.state !== "NEEDS_REVIEW")
        .modify({ state: "AUTH_REQUIRED", last_error: "AUTH_REQUIRED" });
    throw e;
  }
  const items = await db.outbox
    .filter(
      (o) =>
        o.state !== "ACKED" &&
        o.state !== "NEEDS_REVIEW" &&
        (force || o.next_retry_at <= Date.now()),
    )
    .toArray();
  for (const item of items) {
    if (item.actor_id && item.actor_id !== user.user.id) {
      await db.outbox.update(item.id, {
        state: "AUTH_REQUIRED",
        last_error: "ORIGINAL_OPERATOR_REQUIRED",
      });
      continue;
    }
    await db.outbox.update(item.id, { state: "SENDING" });
    try {
      if (!item.payload.was_offline) await api("/sync/register", item.payload);
      const posted = await api<Posted>("/sales", item.payload, {
        "Idempotency-Key": item.id,
      });
      await db.outbox.update(item.id, {
        state: "ACKED",
        posted,
        last_error: undefined,
      });
    } catch (e) {
      const error =
        e instanceof ApiError
          ? e
          : new ApiError("SERVICE_UNAVAILABLE", 0, "Retry required");
      const state: Outbox["state"] =
        error.status === 401
          ? "AUTH_REQUIRED"
          : [400, 403, 404, 409, 422].includes(error.status)
            ? "NEEDS_REVIEW"
            : "RETRY";
      const attempts = item.attempts + 1;
      const wait = Math.max(
        error.retryAfter * 1000,
        Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)) +
          Math.random() * 500,
      );
      await db.outbox.update(item.id, {
        state,
        attempts,
        last_error: error.code,
        next_retry_at: Date.now() + wait,
      });
      if (state === "AUTH_REQUIRED") break;
    }
  }
  await pullCatalogue();
  await putMeta("last_sync", new Date().toISOString());
}
export function synchronize(force = false): Promise<void> {
  if (ongoing) return ongoing;
  ongoing = drain(force).finally(() => {
    ongoing = null;
  });
  return ongoing;
}
