import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction, requireThat, numbers } from "./db.ts";
import { audit, openShift, type Context } from "./context.ts";
export async function expectedCash(
  db: pg.Pool | pg.PoolClient,
  store: string,
  shift: string,
) {
  const r = await db.query(
    `SELECT s.opening_float_minor+coalesce((SELECT sum(p.amount_applied_minor) FROM payments p JOIN sales x ON (x.store_id,x.id)=(p.store_id,p.sale_id) WHERE x.store_id=s.store_id AND x.shift_id=s.id AND p.method='CASH'),0)-coalesce((SELECT sum(p.amount_minor) FROM refund_payments p JOIN refunds x ON (x.store_id,x.id)=(p.store_id,p.refund_id) WHERE x.store_id=s.store_id AND x.shift_id=s.id AND p.method='CASH'),0)+coalesce((SELECT sum(amount_minor) FROM cash_movements WHERE store_id=s.store_id AND shift_id=s.id),0) AS expected FROM shifts s WHERE s.store_id=$1 AND s.id=$2`,
    [store, shift],
  );
  requireThat(r.rows[0], "NOT_FOUND", 404);
  return Number(r.rows[0].expected);
}
export async function currentShift(pool: pg.Pool, ctx: Context) {
  const s = (
    await pool.query(
      "SELECT * FROM shifts WHERE store_id=$1 AND state='OPEN'",
      [ctx.actor.store_id],
    )
  ).rows[0];
  return s
    ? numbers({
        ...s,
        business_date: s.business_date,
        expected_cash_minor: await expectedCash(pool, ctx.actor.store_id, s.id),
      })
    : null;
}
export async function newShift(
  pool: pg.Pool,
  ctx: Context,
  device: string,
  float: number,
) {
  return transaction(pool, async (db) => {
    const d = (
      await db.query(
        "SELECT * FROM devices WHERE store_id=$1 AND id=$2 AND revoked_at IS NULL AND selling FOR UPDATE",
        [ctx.actor.store_id, device],
      )
    ).rows[0];
    requireThat(d, "FORBIDDEN", 403);
    const id = randomUUID();
    const s = (
      await db.query(
        "INSERT INTO shifts(id,store_id,device_id,opened_by,business_date,opening_float_minor) SELECT $1,id,$3,$4,(now() AT TIME ZONE timezone)::date,$5 FROM stores WHERE id=$2 RETURNING *",
        [id, ctx.actor.store_id, device, ctx.actor.id, float],
      )
    ).rows[0];
    await audit(db, { ...ctx, deviceId: device }, "SHIFT_OPENED", "shift", id);
    return numbers(s);
  });
}
export async function reconcile(
  pool: pg.Pool,
  ctx: Context,
  id: string,
  device: string,
  ids: string[],
  pending: number,
) {
  return transaction(pool, async (db) => {
    const s = await openShift(db, ctx, id, ctx.actor.role === "CASHIER");
    requireThat(s.device_id === device, "FORBIDDEN", 403);
    requireThat(
      pending === 0,
      "NEEDS_REVIEW",
      409,
      "Sync all terminal documents before closing",
    );
    requireThat(
      !(
        await db.query(
          "SELECT 1 FROM terminal_documents d WHERE d.store_id=$1 AND d.shift_id=$2 AND NOT EXISTS(SELECT 1 FROM sales s WHERE s.store_id=d.store_id AND s.client_sale_id=d.client_sale_id)",
          [ctx.actor.store_id, id],
        )
      ).rowCount,
      "NEEDS_REVIEW",
      409,
      "Registered terminal documents are not posted",
    );
    const posted = (
      await db.query(
        "SELECT client_sale_id FROM sales WHERE store_id=$1 AND shift_id=$2",
        [ctx.actor.store_id, id],
      )
    ).rows
      .map((r) => r.client_sale_id)
      .sort();
    requireThat(
      JSON.stringify([...new Set(ids)].sort()) === JSON.stringify(posted),
      "NEEDS_REVIEW",
      409,
      "Terminal and server sale identities disagree",
    );
    requireThat(
      !(
        await db.query(
          "SELECT 1 FROM sync_quarantine WHERE store_id=$1 AND device_id=$2 AND resolved_at IS NULL",
          [ctx.actor.store_id, device],
        )
      ).rowCount,
      "NEEDS_REVIEW",
      409,
      "Resolve quarantined documents before closing",
    );
    requireThat(
      !(
        await db.query(
          "SELECT 1 FROM stock_balances WHERE store_id=$1 AND quantity<0",
          [ctx.actor.store_id],
        )
      ).rowCount,
      "NEEDS_REVIEW",
      409,
      "Recount negative stock with a manager before closing",
    );
    const token = randomUUID();
    await db.query(
      "INSERT INTO terminal_reconciliations(id,store_id,shift_id,device_id,sale_ids) VALUES($1,$2,$3,$4,$5)",
      [token, ctx.actor.store_id, id, device, JSON.stringify(posted)],
    );
    return { reconciliation_id: token };
  });
}
export async function closeShift(
  pool: pg.Pool,
  ctx: Context,
  id: string,
  count: number,
  reason: string | undefined,
  token: string,
) {
  return transaction(pool, async (db) => {
    const s = await openShift(db, ctx, id, ctx.actor.role === "CASHIER");
    const ack = (
      await db.query(
        "SELECT * FROM terminal_reconciliations WHERE store_id=$1 AND shift_id=$2 AND id=$3",
        [ctx.actor.store_id, id, token],
      )
    ).rows[0];
    requireThat(ack, "NEEDS_REVIEW", 409);
    const ids = (
      await db.query(
        "SELECT client_sale_id FROM sales WHERE store_id=$1 AND shift_id=$2 ORDER BY client_sale_id",
        [ctx.actor.store_id, id],
      )
    ).rows.map((r) => r.client_sale_id);
    requireThat(
      JSON.stringify(ids) === JSON.stringify(ack.sale_ids),
      "NEEDS_REVIEW",
      409,
      "Sales changed since reconciliation",
    );
    requireThat(
      !(
        await db.query(
          "SELECT 1 FROM sync_quarantine WHERE store_id=$1 AND device_id=$2 AND resolved_at IS NULL",
          [ctx.actor.store_id, s.device_id],
        )
      ).rowCount,
      "NEEDS_REVIEW",
      409,
    );
    const expected = await expectedCash(db, ctx.actor.store_id, id);
    requireThat(
      count === expected || reason?.trim(),
      "VALIDATION_ERROR",
      422,
      "A nonzero variance requires a reason",
    );
    const row = (
      await db.query(
        "UPDATE shifts SET state='CLOSED',closed_at=now(),closed_by=$3,expected_cash_minor=$4,counted_cash_minor=$5,variance_minor=$5::bigint-$4::bigint,variance_reason=$6,version=version+1 WHERE store_id=$1 AND id=$2 RETURNING *",
        [ctx.actor.store_id, id, ctx.actor.id, expected, count, reason ?? null],
      )
    ).rows[0];
    await audit(db, ctx, "SHIFT_CLOSED", "shift", id, reason);
    return numbers(row);
  });
}
export async function cashMove(
  pool: pg.Pool,
  ctx: Context,
  shift: string,
  id: string,
  amount: number,
  reason: string,
) {
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      ctx.actor.store_id + ":cash:" + id,
    ]);
    const prior = (
      await db.query(
        "SELECT * FROM cash_movements WHERE store_id=$1 AND id=$2",
        [ctx.actor.store_id, id],
      )
    ).rows[0];
    if (prior) {
      requireThat(
        prior.shift_id === shift &&
          prior.actor_id === ctx.actor.id &&
          Number(prior.amount_minor) === amount &&
          prior.reason === reason,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      return { id };
    }
    await openShift(db, ctx, shift, ctx.actor.role === "CASHIER");
    await db.query(
      "INSERT INTO cash_movements(id,store_id,shift_id,actor_id,amount_minor,reason) VALUES($1,$2,$3,$4,$5,$6)",
      [id, ctx.actor.store_id, shift, ctx.actor.id, amount, reason],
    );
    await audit(db, ctx, "CASH_MOVEMENT", "shift", shift, reason);
    return { id };
  });
}
