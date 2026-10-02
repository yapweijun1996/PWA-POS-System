import { randomUUID } from "node:crypto";
import type pg from "pg";
import { canonical } from "../../../packages/domain/money.ts";
import { productWrite } from "../../../packages/contracts/index.ts";
import { transaction, requireThat, numbers } from "./db.ts";
import { manager, audit, movement, digest, type Context } from "./context.ts";
export async function catalogue(
  pool: pg.Pool | pg.PoolClient,
  ctx: Context,
  includeArchived = false,
  limit = 100,
  offset = 0,
) {
  const cost = ctx.actor.role === "MANAGER" ? ",p.cost_minor" : "";
  const r = await pool.query(
    `SELECT p.id,p.name,p.sku,p.barcode,p.category_id,c.name AS category_name,p.active,p.version,p.low_stock_threshold,pp.id AS price_revision_id,pp.unit_price_minor,pp.tax_bps,b.quantity,b.version AS balance_version${cost} FROM products p JOIN categories c ON (c.store_id,c.id)=(p.store_id,p.category_id) JOIN LATERAL (SELECT * FROM product_prices WHERE store_id=p.store_id AND product_id=p.id ORDER BY catalogue_version DESC LIMIT 1) pp ON true JOIN stock_balances b ON (b.store_id,b.product_id)=(p.store_id,p.id) WHERE p.store_id=$1 AND ($2 OR p.active) ORDER BY p.name,p.id LIMIT $3 OFFSET $4`,
    [ctx.actor.store_id, includeArchived, limit, offset],
  );
  return numbers(r.rows);
}
export async function saveProduct(
  pool: pg.Pool,
  ctx: Context,
  body: unknown,
  id: string = randomUUID(),
  edit = false,
) {
  manager(ctx);
  const p = productWrite.parse(body);
  return transaction(pool, async (db) => {
    await db.query("SELECT id FROM stores WHERE id=$1 FOR UPDATE", [
      ctx.actor.store_id,
    ]);
    requireThat(
      (
        await db.query(
          "SELECT id FROM categories WHERE store_id=$1 AND id=$2",
          [ctx.actor.store_id, p.category_id],
        )
      ).rowCount,
      "NOT_FOUND",
      404,
    );
    if (edit) {
      const current = (
        await db.query(
          "SELECT * FROM products WHERE store_id=$1 AND id=$2 FOR UPDATE",
          [ctx.actor.store_id, id],
        )
      ).rows[0];
      requireThat(current, "NOT_FOUND", 404);
      requireThat(
        current.version === String(p.expected_version),
        "VERSION_CONFLICT",
        409,
      );
      await db.query(
        "UPDATE products SET name=$3,sku=$4,barcode=$5,category_id=$6,cost_minor=$7,low_stock_threshold=$8,active=$9,version=version+1,updated_at=now() WHERE store_id=$1 AND id=$2",
        [
          ctx.actor.store_id,
          id,
          p.name,
          p.sku,
          p.barcode || null,
          p.category_id,
          p.cost_minor,
          p.low_stock_threshold,
          p.active,
        ],
      );
    } else {
      await db.query(
        "INSERT INTO products(id,store_id,name,sku,barcode,category_id,cost_minor,low_stock_threshold,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          ctx.actor.store_id,
          p.name,
          p.sku,
          p.barcode || null,
          p.category_id,
          p.cost_minor,
          p.low_stock_threshold,
          p.active,
        ],
      );
      await db.query(
        "INSERT INTO stock_balances(store_id,product_id) VALUES($1,$2)",
        [ctx.actor.store_id, id],
      );
    }
    const version = (
      await db.query(
        "UPDATE stores SET catalogue_version=catalogue_version+1 WHERE id=$1 RETURNING catalogue_version",
        [ctx.actor.store_id],
      )
    ).rows[0].catalogue_version;
    await db.query(
      "INSERT INTO product_prices(id,store_id,product_id,catalogue_version,unit_price_minor,tax_bps,created_by,name_snapshot,sku_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        ctx.actor.store_id,
        id,
        version,
        p.unit_price_minor,
        p.tax_bps,
        ctx.actor.id,
        p.name,
        p.sku,
      ],
    );
    await audit(
      db,
      ctx,
      edit ? "PRODUCT_UPDATED" : "PRODUCT_CREATED",
      "product",
      id,
    );
    return { id };
  });
}
export async function stockWrite(
  pool: pg.Pool,
  ctx: Context,
  p: {
    client_event_id: string;
    product_id: string;
    quantity?: number;
    counted_quantity?: number;
    expected_version?: number;
    reason: string;
  },
  type: "RECEIPT" | "ADJUSTMENT",
) {
  manager(ctx);
  return transaction(pool, async (db) => {
    const hash = digest(canonical({ ...p, type }));
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      ctx.actor.store_id + ":stock:" + p.client_event_id,
    ]);
    const prior = (
      await db.query(
        "SELECT command_sha256 FROM stock_movements WHERE store_id=$1 AND admin_event_id=$2",
        [ctx.actor.store_id, p.client_event_id],
      )
    ).rows[0];
    if (prior) {
      requireThat(prior.command_sha256 === hash, "IDEMPOTENCY_CONFLICT", 409);
      return { replayed: true };
    }
    await db.query("SELECT id FROM stores WHERE id=$1 FOR UPDATE", [
      ctx.actor.store_id,
    ]);
    const b = (
      await db.query(
        "SELECT * FROM stock_balances WHERE store_id=$1 AND product_id=$2 FOR UPDATE",
        [ctx.actor.store_id, p.product_id],
      )
    ).rows[0];
    requireThat(b, "NOT_FOUND", 404);
    if (type === "ADJUSTMENT")
      requireThat(
        String(p.expected_version) === b.version,
        "VERSION_CONFLICT",
        409,
        "Stock changed; refresh and recount",
      );
    const delta =
      type === "RECEIPT" ? p.quantity! : p.counted_quantity! - b.quantity;
    requireThat(Number.isInteger(delta) && delta !== 0, "VALIDATION_ERROR");
    await movement(
      db,
      ctx,
      p.product_id,
      delta,
      type,
      type,
      p.reason,
      undefined,
      p.client_event_id,
      hash,
    );
    await audit(db, ctx, type, "product", p.product_id, p.reason);
    return numbers(
      (
        await db.query(
          "SELECT * FROM stock_balances WHERE store_id=$1 AND product_id=$2",
          [ctx.actor.store_id, p.product_id],
        )
      ).rows[0],
    );
  });
}
