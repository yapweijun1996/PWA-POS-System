import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import {
  saleCommand,
  type SaleCommand,
} from "../../../packages/contracts/index.ts";
import {
  canonical,
  lineMoney,
  saleMoney,
} from "../../../packages/domain/money.ts";
import { transaction, requireThat, numbers, Problem } from "./db.ts";
import { digest, audit, movement, openShift, type Context } from "./context.ts";
export const permitSignature = (claims: unknown, secret: string) =>
  createHmac("sha256", secret).update(canonical(claims)).digest("hex");
export async function issuePermit(
  pool: pg.Pool,
  ctx: Context,
  shiftId: string,
  secret: string,
) {
  return transaction(pool, async (db) => {
    const shift = await openShift(db, ctx, shiftId, true);
    const revisions = (
      await db.query("SELECT id FROM product_prices WHERE store_id=$1", [
        ctx.actor.store_id,
      ])
    ).rows.map((r) => r.id);
    const id = randomUUID(),
      issued = new Date(),
      expires = new Date(issued.getTime() + 12 * 60 * 60 * 1000);
    const claims = {
      id,
      store_id: ctx.actor.store_id,
      user_id: ctx.actor.id,
      device_id: shift.device_id,
      shift_id: shiftId,
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
      max_sales: 200,
      revisions,
      discount_bps: 0,
      methods: ["CASH"],
    };
    const signature = permitSignature(claims, secret);
    await db.query(
      "INSERT INTO offline_permits(id,store_id,shift_id,device_id,user_id,issued_at,expires_at,max_sales,signed_claims,signature) VALUES($1,$2,$3,$4,$5,$6,$7,200,$8,$9)",
      [
        id,
        ctx.actor.store_id,
        shiftId,
        shift.device_id,
        ctx.actor.id,
        issued,
        expires,
        claims,
        signature,
      ],
    );
    return {
      id,
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
      max_sales: 200,
      signed_claims: claims,
      signature,
    };
  });
}
function result(s: Record<string, unknown>) {
  return numbers({
    sale_id: s.id,
    client_sale_id: s.client_sale_id,
    receipt_no: s.receipt_no,
    posted_at: s.posted_at,
    business_date: s.business_date,
    total_minor: s.total_minor,
    sync_cursor: String(s.receipt_seq),
    review_flags: s.review_flags,
  });
}
function totals(s: SaleCommand) {
  let calculated;
  try {
    calculated = saleMoney(s.lines);
  } catch {
    throw new Problem("VALIDATION_ERROR", 422, "Amount limit exceeded");
  }
  for (const [key, value] of Object.entries(calculated))
    requireThat(
      s[key as keyof typeof calculated] === value,
      "VALIDATION_ERROR",
      422,
      "Sale totals do not reconcile",
    );
  for (const l of s.lines) {
    const m = lineMoney(l);
    requireThat(
      l.tax_minor === m.tax_minor && l.line_total_minor === m.line_total_minor,
      "VALIDATION_ERROR",
    );
  }
  const p = s.payment;
  requireThat(
    p.amount_applied_minor === s.total_minor &&
      p.tender_minor - p.change_minor === s.total_minor,
    "VALIDATION_ERROR",
    422,
    "Payment does not reconcile",
  );
  if (p.method === "CASH")
    requireThat(
      !p.external_reference && !p.operator_verified_at,
      "VALIDATION_ERROR",
    );
  else
    requireThat(
      !s.was_offline &&
        p.change_minor === 0 &&
        p.external_reference &&
        p.operator_verified_at,
      "VALIDATION_ERROR",
      422,
      "External payments require an online external record",
    );
}
export async function postSale(
  pool: pg.Pool,
  ctx: Context,
  body: unknown,
  key: string | undefined,
  secret: string,
) {
  const s = saleCommand.parse(body);
  requireThat(
    key === s.client_sale_id,
    "VALIDATION_ERROR",
    400,
    "Idempotency-Key must match the sale UUID",
  );
  const hash = digest(canonical(s));
  try {
    return await transaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${ctx.actor.store_id}:sale:${s.client_sale_id}`,
      ]);
      const existing = (
        await db.query(
          "SELECT * FROM sales WHERE store_id=$1 AND client_sale_id=$2",
          [ctx.actor.store_id, s.client_sale_id],
        )
      ).rows[0];
      if (existing) {
        requireThat(
          existing.payload_sha256 === hash,
          "IDEMPOTENCY_CONFLICT",
          409,
        );
        return { status: 200, body: result(existing) };
      }
      totals(s);
      const store = (
        await db.query("SELECT * FROM stores WHERE id=$1", [ctx.actor.store_id])
      ).rows[0];
      requireThat(s.currency === store.currency, "VALIDATION_ERROR");
      const shift = await openShift(db, ctx, s.shift_id, true);
      requireThat(shift.device_id === s.device_id, "FORBIDDEN", 403);
      const device = (
        await db.query(
          "SELECT * FROM devices WHERE store_id=$1 AND id=$2 AND revoked_at IS NULL AND selling",
          [ctx.actor.store_id, s.device_id],
        )
      ).rows[0];
      requireThat(device, "FORBIDDEN", 403);
      let claims: { revisions: string[]; discount_bps: number } | undefined;
      if (s.was_offline) {
        requireThat(
          s.payment.method === "CASH" && s.offline_permit_id,
          "OFFLINE_PERMIT_INVALID",
        );
        const permit = (
          await db.query(
            "SELECT * FROM offline_permits WHERE store_id=$1 AND id=$2",
            [ctx.actor.store_id, s.offline_permit_id],
          )
        ).rows[0];
        requireThat(
          permit &&
            permit.user_id === ctx.actor.id &&
            permit.device_id === s.device_id &&
            permit.shift_id === s.shift_id &&
            !permit.revoked_at,
          "OFFLINE_PERMIT_INVALID",
        );
        const expected = permitSignature(permit.signed_claims, secret);
        requireThat(
          permit.signature.length === expected.length &&
            timingSafeEqual(
              Buffer.from(permit.signature),
              Buffer.from(expected),
            ),
          "OFFLINE_PERMIT_INVALID",
        );
        const time = Date.parse(s.client_created_at);
        requireThat(
          time >= new Date(permit.issued_at).getTime() &&
            time <= new Date(permit.expires_at).getTime(),
          "OFFLINE_PERMIT_INVALID",
        );
        requireThat(
          Number(
            (
              await db.query(
                "SELECT count(*) FROM sales WHERE store_id=$1 AND offline_permit_id=$2",
                [ctx.actor.store_id, permit.id],
              )
            ).rows[0].count,
          ) < permit.max_sales,
          "OFFLINE_PERMIT_INVALID",
        );
        claims = permit.signed_claims;
      } else requireThat(!s.offline_permit_id, "VALIDATION_ERROR");
      const productIds = [...new Set(s.lines.map((l) => l.product_id))].sort();
      const stock = new Map<string, number>();
      for (const id of productIds) {
        const b = (
          await db.query(
            "SELECT quantity FROM stock_balances WHERE store_id=$1 AND product_id=$2 FOR UPDATE",
            [ctx.actor.store_id, id],
          )
        ).rows[0];
        requireThat(b, "NOT_FOUND", 404);
        stock.set(id, b.quantity);
      }
      const flags: string[] = [];
      for (const l of s.lines) {
        const p = (
          await db.query(
            "SELECT pp.*,p.active,p.name,p.sku FROM product_prices pp JOIN products p ON (p.store_id,p.id)=(pp.store_id,pp.product_id) WHERE pp.store_id=$1 AND pp.product_id=$2 AND pp.id=$3",
            [ctx.actor.store_id, l.product_id, l.price_revision_id],
          )
        ).rows[0];
        requireThat(p, "NEEDS_REVIEW", 422, "Unknown product price revision");
        requireThat(
          Number(p.unit_price_minor) === l.unit_price_minor &&
            p.tax_bps === l.tax_bps,
          "NEEDS_REVIEW",
        );
        if (s.was_offline) {
          requireThat(
            claims!.revisions.includes(l.price_revision_id) &&
              l.discount_minor * 10000 <=
                l.quantity * l.unit_price_minor * claims!.discount_bps,
            "OFFLINE_PERMIT_INVALID",
          );
          requireThat(
            l.name_snapshot === p.name_snapshot &&
              l.sku_snapshot === p.sku_snapshot,
            "NEEDS_REVIEW",
          );
        } else {
          const latest = (
            await db.query(
              "SELECT id FROM product_prices WHERE store_id=$1 AND product_id=$2 ORDER BY catalogue_version DESC LIMIT 1",
              [ctx.actor.store_id, l.product_id],
            )
          ).rows[0];
          requireThat(
            p.active &&
              latest.id === l.price_revision_id &&
              l.name_snapshot === p.name &&
              l.sku_snapshot === p.sku,
            "VERSION_CONFLICT",
            409,
            "Product changed; review the current price",
          );
          requireThat(
            ctx.actor.role === "MANAGER" || l.discount_minor === 0,
            "FORBIDDEN",
            403,
          );
        }
        stock.set(l.product_id, stock.get(l.product_id)! - l.quantity);
      }
      for (const q of stock.values())
        if (q < 0) {
          if (!s.was_offline)
            throw new Problem("STOCK_UNAVAILABLE", 409, "Insufficient stock");
          flags.push("NEGATIVE_STOCK");
          break;
        }
      const id = randomUUID();
      const seq = (
        await db.query(
          "SELECT nextval(pg_get_serial_sequence('sales','receipt_seq')) AS seq",
        )
      ).rows[0].seq;
      const receipt = `POS-${String(seq).padStart(6, "0")}`;
      const posted = (
        await db.query(
          "INSERT INTO sales(id,store_id,client_sale_id,shift_id,device_id,cashier_id,offline_permit_id,receipt_no,receipt_seq,currency,gross_minor,discount_minor,tax_minor,total_minor,payload_sha256,schema_version,was_offline,business_date,client_created_at,review_flags) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16,$17,$18,$19) RETURNING *",
          [
            id,
            ctx.actor.store_id,
            s.client_sale_id,
            s.shift_id,
            s.device_id,
            ctx.actor.id,
            s.offline_permit_id ?? null,
            receipt,
            seq,
            s.currency,
            s.gross_minor,
            s.discount_minor,
            s.tax_minor,
            s.total_minor,
            hash,
            s.was_offline,
            shift.business_date,
            s.client_created_at,
            JSON.stringify(flags),
          ],
        )
      ).rows[0];
      for (const [index, l] of s.lines.entries()) {
        await db.query(
          "INSERT INTO sale_lines(id,store_id,sale_id,product_id,price_revision_id,position,sku_snapshot,name_snapshot,quantity,unit_price_minor,discount_minor,tax_bps,tax_minor,line_total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            l.line_id,
            ctx.actor.store_id,
            id,
            l.product_id,
            l.price_revision_id,
            index + 1,
            l.sku_snapshot,
            l.name_snapshot,
            l.quantity,
            l.unit_price_minor,
            l.discount_minor,
            l.tax_bps,
            l.tax_minor,
            l.line_total_minor,
          ],
        );
        await movement(
          db,
          { ...ctx, deviceId: s.device_id },
          l.product_id,
          -l.quantity,
          "SALE",
          receipt,
          undefined,
          l.line_id,
        );
      }
      const p = s.payment;
      await db.query(
        "INSERT INTO payments(id,store_id,sale_id,method,amount_applied_minor,tender_minor,change_minor,external_reference,operator_verified_at,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          randomUUID(),
          ctx.actor.store_id,
          id,
          p.method,
          p.amount_applied_minor,
          p.tender_minor,
          p.change_minor,
          p.external_reference ?? null,
          p.operator_verified_at ?? null,
          ctx.actor.id,
        ],
      );
      await audit(
        db,
        { ...ctx, deviceId: s.device_id },
        "SALE_POSTED",
        "sale",
        id,
      );
      await db.query(
        "INSERT INTO integration_outbox(id,store_id,event_type,aggregate_id,payload) VALUES($1,$2,'pos.sale.posted.v1',$3,$4)",
        [randomUUID(), ctx.actor.store_id, id, JSON.stringify(result(posted))],
      );
      return { status: 201, body: result(posted) };
    });
  } catch (e) {
    if (
      s.was_offline &&
      e instanceof Problem &&
      [
        "OFFLINE_PERMIT_INVALID",
        "NEEDS_REVIEW",
        "FORBIDDEN",
        "SHIFT_NOT_OPEN",
        "IDEMPOTENCY_CONFLICT",
      ].includes(e.code)
    ) {
      // Preserve business evidence after the rejected posting transaction has rolled back.
      await pool.query(
        "INSERT INTO sync_quarantine(id,store_id,device_id,client_document_id,schema_version,payload,payload_sha256,reason_code) SELECT $1,$2,$3,$4,1,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM devices WHERE store_id=$2 AND id=$3) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          ctx.actor.store_id,
          s.device_id,
          s.client_sale_id,
          JSON.stringify(s),
          hash,
          e.code,
        ],
      );
    }
    throw e;
  }
}
