import { randomUUID } from "node:crypto";
import type pg from "pg";
import { refundCommand } from "../../../packages/contracts/index.ts";
import { canonical, refundAllocation } from "../../../packages/domain/money.ts";
import { transaction, requireThat, numbers } from "./db.ts";
import {
  manager,
  openShift,
  digest,
  audit,
  movement,
  type Context,
} from "./context.ts";
export async function postRefund(
  pool: pg.Pool,
  ctx: Context,
  body: unknown,
  key: string | undefined,
) {
  manager(ctx);
  const r = refundCommand.parse(body);
  requireThat(key === r.client_refund_id, "VALIDATION_ERROR", 400);
  const hash = digest(canonical(r));
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${ctx.actor.store_id}:refund:${r.client_refund_id}`,
    ]);
    const previous = (
      await db.query(
        "SELECT * FROM refunds WHERE store_id=$1 AND client_refund_id=$2",
        [ctx.actor.store_id, r.client_refund_id],
      )
    ).rows[0];
    if (previous) {
      requireThat(
        previous.payload_sha256 === hash,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      return { status: 200, body: numbers(previous) };
    }
    const shift = await openShift(db, ctx, r.shift_id);
    const original = (
      await db.query(
        "SELECT * FROM sales WHERE store_id=$1 AND id=$2 FOR UPDATE",
        [ctx.actor.store_id, r.original_sale_id],
      )
    ).rows[0];
    requireThat(original, "NOT_FOUND", 404);
    const payment = (
      await db.query(
        "SELECT method FROM payments WHERE store_id=$1 AND sale_id=$2",
        [ctx.actor.store_id, original.id],
      )
    ).rows[0];
    requireThat(
      r.method === payment.method,
      "VALIDATION_ERROR",
      422,
      "Refund method must match original payment",
    );
    if (r.method !== "CASH")
      requireThat(
        r.external_reference && r.operator_verified_at,
        "VALIDATION_ERROR",
      );
    const allocated = [];
    for (const l of [...r.lines].sort((a, b) =>
      a.original_sale_line_id.localeCompare(b.original_sale_line_id),
    )) {
      const line = numbers(
        (
          await db.query(
            "SELECT * FROM sale_lines WHERE store_id=$1 AND sale_id=$2 AND id=$3 FOR UPDATE",
            [ctx.actor.store_id, original.id, l.original_sale_line_id],
          )
        ).rows[0],
      );
      requireThat(line, "NOT_FOUND", 404);
      const returned = Number(
        (
          await db.query(
            "SELECT coalesce(sum(quantity),0) AS returned FROM refund_lines WHERE store_id=$1 AND original_sale_line_id=$2",
            [ctx.actor.store_id, line.id],
          )
        ).rows[0].returned,
      );
      requireThat(returned + l.quantity <= line.quantity, "REFUND_LIMIT", 409);
      allocated.push({
        id: randomUUID(),
        line,
        l,
        amount: refundAllocation(line, returned, l.quantity),
      });
    }
    const total = allocated.reduce((s, a) => s + a.amount.total_minor, 0);
    const id = randomUUID();
    const posted = (
      await db.query(
        "INSERT INTO refunds(id,store_id,client_refund_id,original_sale_id,shift_id,manager_id,currency,total_minor,reason,payload_sha256,business_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          id,
          ctx.actor.store_id,
          r.client_refund_id,
          original.id,
          shift.id,
          ctx.actor.id,
          original.currency,
          total,
          r.reason,
          hash,
          shift.business_date,
        ],
      )
    ).rows[0];
    for (const a of allocated) {
      const m = a.amount;
      await db.query(
        "INSERT INTO refund_lines(id,store_id,refund_id,original_sale_id,original_sale_line_id,quantity,restock,net_minor,tax_minor,total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          a.id,
          ctx.actor.store_id,
          id,
          original.id,
          a.line.id,
          a.l.quantity,
          a.l.restock,
          m.net_minor,
          m.tax_minor,
          m.total_minor,
        ],
      );
    }
    // Lock all balances in product order before appending restock movements.
    for (const product of [
      ...new Set(
        allocated
          .filter((a) => a.l.restock)
          .map((a) => String(a.line.product_id)),
      ),
    ].sort())
      await db.query(
        "SELECT quantity FROM stock_balances WHERE store_id=$1 AND product_id=$2 FOR UPDATE",
        [ctx.actor.store_id, product],
      );
    for (const a of allocated)
      if (a.l.restock)
        await movement(
          db,
          ctx,
          a.line.product_id,
          a.l.quantity,
          "RETURN",
          id,
          r.reason,
          a.id,
        );
    await db.query(
      "INSERT INTO refund_payments(id,store_id,refund_id,method,amount_minor,external_reference,operator_verified_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        ctx.actor.store_id,
        id,
        r.method,
        total,
        r.external_reference ?? null,
        r.operator_verified_at ?? null,
      ],
    );
    await audit(db, ctx, "REFUND_POSTED", "refund", id, r.reason);
    await db.query(
      "INSERT INTO integration_outbox(id,store_id,event_type,aggregate_id,payload) VALUES($1,$2,'pos.refund.posted.v1',$3,$4)",
      [
        randomUUID(),
        ctx.actor.store_id,
        id,
        JSON.stringify({ refund_id: id, total_minor: total }),
      ],
    );
    return { status: 201, body: numbers(posted) };
  });
}
