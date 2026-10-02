import Dexie, { type Table } from "dexie";
import type {
  Product,
  SaleCommand,
  Posted,
} from "../../../packages/contracts/index.ts";
import { canonical } from "../../../packages/domain/money.ts";
export type Outbox = {
  id: string;
  payload: SaleCommand;
  hash: string;
  state:
    | "PENDING"
    | "SENDING"
    | "ACKED"
    | "RETRY"
    | "AUTH_REQUIRED"
    | "NEEDS_REVIEW";
  attempts: number;
  next_retry_at: number;
  last_error?: string;
  created_at: number;
  actor_id?: string;
  posted?: Posted;
};
class LocalDatabase extends Dexie {
  products!: Table<Product, string>;
  sales!: Table<SaleCommand, string>;
  lines!: Table<{ id: string; sale: string }, string>;
  payments!: Table<{ id: string; sale: string }, string>;
  deltas!: Table<
    { id: string; sale: string; product: string; quantity: number },
    string
  >;
  outbox!: Table<Outbox, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  held!: Table<{ id: string; lines: CartLine[]; created: number }, string>;
  constructor() {
    super("counter-pos-v1");
    this.version(1).stores({
      products: "id,category_id,sku,barcode",
      sales: "client_sale_id,shift_id",
      lines: "id,sale",
      payments: "id,sale",
      deltas: "id,sale,product",
      outbox: "id,state,created_at",
      meta: "key",
      held: "id,created",
    });
  }
}
export const db = new LocalDatabase();
export type CartLine = {
  product: Product;
  quantity: number;
  discount_minor: number;
  line_id: string;
};
export const writerId = crypto.randomUUID();
export async function meta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
export async function putMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}
export async function lease() {
  return db.transaction("rw", db.meta, async () => {
    const old = await meta<{ owner: string; expires: number }>("writer");
    if (old && old.owner !== writerId && old.expires > Date.now()) return false;
    await putMeta("writer", { owner: writerId, expires: Date.now() + 10000 });
    return true;
  });
}
export async function selfTest() {
  const key = "probe-" + writerId;
  await putMeta(key, key);
  if ((await meta(key)) !== key)
    throw new Error("Local storage verification failed");
  await db.meta.delete(key);
}
export async function hashPayload(payload: unknown) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(payload)),
  );
  return [...new Uint8Array(buffer)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function commitSale(
  payload: SaleCommand,
  options: { fail?: boolean; actor_id?: string } = {},
) {
  const hash = await hashPayload(payload);
  await db.transaction(
    "rw",
    [db.sales, db.lines, db.payments, db.deltas, db.outbox, db.meta],
    async () => {
      const l = await meta<{ owner: string; expires: number }>("writer");
      if (!l || l.owner !== writerId || l.expires <= Date.now())
        throw new Error("Another tab controls this terminal");
      if (payload.was_offline) {
        const count = await db.sales
          .filter((s) => s.offline_permit_id === payload.offline_permit_id)
          .count();
        if (count >= 200) throw new Error("Offline permit sale limit reached");
      }
      if (await db.sales.get(payload.client_sale_id)) return;
      await db.sales.add(payload);
      await db.lines.bulkAdd(
        payload.lines.map((l) => ({
          ...l,
          id: l.line_id,
          sale: payload.client_sale_id,
        })),
      );
      await db.payments.add({
        ...payload.payment,
        id: payload.client_sale_id,
        sale: payload.client_sale_id,
      });
      await db.deltas.bulkAdd(
        payload.lines.map((l) => ({
          id: l.line_id,
          sale: payload.client_sale_id,
          product: l.product_id,
          quantity: -l.quantity,
        })),
      );
      if (options.fail)
        throw new DOMException(
          "Injected storage quota failure",
          "QuotaExceededError",
        );
      await db.outbox.add({
        id: payload.client_sale_id,
        payload,
        hash,
        state: "PENDING",
        actor_id: options.actor_id,
        attempts: 0,
        next_retry_at: 0,
        created_at: Date.now(),
      });
      await putMeta("cart", []);
    },
  );
}
export async function localQuantities() {
  const deltas = await db.deltas.toArray();
  const sums = new Map<string, number>();
  for (const d of deltas)
    sums.set(d.product, (sums.get(d.product) ?? 0) + d.quantity);
  return sums;
}
