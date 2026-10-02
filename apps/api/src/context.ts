import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";
import type { Actor } from "../../../packages/contracts/index.ts";
import { requireThat } from "./db.ts";
export type Context = { actor: Actor; requestId: string; deviceId?: string };
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function manager(ctx: Context) {
  requireThat(
    ctx.actor.role === "MANAGER",
    "FORBIDDEN",
    403,
    "Manager permission required",
  );
}
export async function audit(
  db: pg.PoolClient,
  ctx: Context,
  action: string,
  type: string,
  id: string,
  reason?: string,
) {
  await db.query(
    "INSERT INTO audit_events(id,store_id,actor_id,device_id,action,subject_type,subject_id,reason,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      randomUUID(),
      ctx.actor.store_id,
      ctx.actor.id,
      ctx.deviceId ?? null,
      action,
      type,
      id,
      reason ?? null,
      ctx.requestId,
    ],
  );
}
export async function openShift(
  db: pg.PoolClient,
  ctx: Context,
  id: string,
  own = false,
) {
  const r = await db.query(
    "SELECT * FROM shifts WHERE store_id=$1 AND id=$2 FOR UPDATE",
    [ctx.actor.store_id, id],
  );
  const s = r.rows[0];
  requireThat(s && s.state === "OPEN", "SHIFT_NOT_OPEN", 409);
  if (own)
    requireThat(
      s.opened_by === ctx.actor.id,
      "FORBIDDEN",
      403,
      "This shift belongs to another operator",
    );
  return s;
}
export async function movement(
  db: pg.PoolClient,
  ctx: Context,
  product: string,
  delta: number,
  type: string,
  reference: string,
  reason?: string,
  line?: string,
  eventId?: string,
  commandHash?: string,
) {
  await db.query(
    "UPDATE stock_balances SET quantity=quantity+$3,version=version+1,updated_at=now() WHERE store_id=$1 AND product_id=$2",
    [ctx.actor.store_id, product, delta],
  );
  await db.query(
    "INSERT INTO stock_movements(id,store_id,product_id,movement_type,quantity_delta,sale_line_id,refund_line_id,admin_event_id,reference,reason,actor_id,command_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      randomUUID(),
      ctx.actor.store_id,
      product,
      type,
      delta,
      type === "SALE" ? line : null,
      type === "RETURN" ? line : null,
      ["RECEIPT", "ADJUSTMENT"].includes(type)
        ? (eventId ?? randomUUID())
        : null,
      reference,
      reason ?? null,
      ctx.actor.id,
      commandHash ?? null,
    ],
  );
}
