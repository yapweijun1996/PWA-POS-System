import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import { database, transaction, Problem, requireThat, numbers } from "./db.ts";
import type { Config } from "./config.ts";
import { sessions } from "./auth.ts";
import { manager, audit, digest } from "./context.ts";
import { catalogue, saveProduct, stockWrite } from "./catalogue.ts";
import { postSale, issuePermit } from "./sales.ts";
import { postRefund } from "./refunds.ts";
import { canonical } from "../../../packages/domain/money.ts";
import { cursor, nextCursor } from "./pagination.ts";
import { saleCommand } from "../../../packages/contracts/index.ts";
import {
  currentShift,
  newShift,
  reconcile,
  closeShift,
  cashMove,
} from "./shifts.ts";
const id = z.string().uuid(),
  money = z.number().int().min(0).max(1e9),
  reason = z.string().trim().min(1).max(500);
export async function createApp(config: Config) {
  const pool = database(config.databaseUrl);
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: false,
    genReqId: () => randomUUID(),
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.test ? 10000 : 300,
    timeWindow: "1 minute",
  });
  await sessions(app, pool, config);
  app.addHook("onClose", async () => {
    await pool.end();
  });
  app.addHook("onSend", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (
      req.url.startsWith("/api") ||
      req.url === "/sw.js" ||
      req.url === "/" ||
      req.url.endsWith(".html")
    )
      reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, req, reply) => {
    const code = (error as { code?: string }).code;
    const problem =
      error instanceof Problem
        ? error
        : error instanceof ZodError
          ? new Problem("VALIDATION_ERROR", 422, "Invalid request fields")
          : code === "23505"
            ? new Problem(
                "VERSION_CONFLICT",
                409,
                "Identity already exists or a shift is already open",
              )
            : code === "23503"
              ? new Problem("NOT_FOUND", 404)
              : new Problem(
                  "SERVICE_UNAVAILABLE",
                  503,
                  "Service unavailable; retry the same document",
                  true,
                );
    if (error instanceof ZodError)
      return reply.code(problem.status).send({
        code: problem.code,
        message: problem.message,
        request_id: req.id,
        retryable: false,
        details: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if ((error as { statusCode?: number }).statusCode === 429)
      return reply.code(429).send({
        code: "RATE_LIMITED",
        message: "Try again shortly",
        request_id: req.id,
        retryable: true,
        details: [],
      });
    if (
      config.test &&
      !(error instanceof Problem) &&
      !(error instanceof ZodError)
    )
      console.error(error);
    return reply.code(problem.status).send({
      code: problem.code,
      message: problem.message,
      request_id: req.id,
      retryable: problem.retryable,
      details: [],
    });
  });
  app.get("/health/live", () => ({ status: "live", demo: config.demo }));
  app.get("/health/ready", async () => {
    const r = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    requireThat(
      [
        "001-core.sql",
        "002-runtime.sql",
        "003-runtime-grants.sql",
        "004-history-row-locks.sql",
        "005-recovery-controls.sql",
      ].every((v) => r.rows.some((r) => r.version === v)),
      "SERVICE_UNAVAILABLE",
      503,
    );
    return { status: "ready" };
  });
  app.get("/api/v1/bootstrap", async (req) => ({
    store: (
      await pool.query(
        "SELECT id,name,currency,timezone,tax_enabled,catalogue_version FROM stores WHERE id=$1",
        [req.context.actor.store_id],
      )
    ).rows[0],
    user: req.context.actor,
    devices: (
      await pool.query(
        "SELECT id,name,revoked_at FROM devices WHERE store_id=$1 ORDER BY name",
        [req.context.actor.store_id],
      )
    ).rows,
    csrf_token: req.csrf,
    server_time: new Date().toISOString(),
  }));
  app.get(
    "/api/v1/categories",
    async (req) =>
      (
        await pool.query(
          "SELECT id,name FROM categories WHERE store_id=$1 AND active ORDER BY sort_order,name",
          [req.context.actor.store_id],
        )
      ).rows,
  );
  app.post("/api/v1/categories", async (req, reply) => {
    manager(req.context);
    const p = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(req.body);
    const cid = randomUUID();
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO categories(id,store_id,name) VALUES($1,$2,$3)",
        [cid, req.context.actor.store_id, p.name],
      );
      await audit(db, req.context, "CATEGORY_CREATED", "category", cid);
    });
    return reply.code(201).send({ id: cid, name: p.name });
  });
  app.get("/api/v1/products", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(100),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        cursor: z.string().max(100).optional(),
        archived: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const offset = q.cursor ? cursor(q.cursor) : q.offset;
    const items = await catalogue(
      pool,
      req.context,
      q.archived === "true",
      q.limit,
      offset,
    );
    return {
      items,
      next_cursor:
        items.length === q.limit ? nextCursor(offset + q.limit) : null,
    };
  });
  app.post("/api/v1/products", async (req, reply) =>
    reply.code(201).send(await saveProduct(pool, req.context, req.body)),
  );
  app.patch("/api/v1/products/:id", async (req) =>
    saveProduct(
      pool,
      req.context,
      req.body,
      id.parse((req.params as { id: string }).id),
      true,
    ),
  );
  app.post("/api/v1/devices", async (req, reply) => {
    manager(req.context);
    const p = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(req.body);
    const did = randomUUID();
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO devices(id,store_id,name,enrolled_by) VALUES($1,$2,$3,$4)",
        [did, req.context.actor.store_id, p.name, req.context.actor.id],
      );
      await audit(db, req.context, "DEVICE_ENROLLED", "device", did);
    });
    return reply.code(201).send({ id: did, name: p.name });
  });
  app.get("/api/v1/inventory/balances", async (req) => {
    manager(req.context);
    return catalogue(pool, req.context, true);
  });
  app.get("/api/v1/inventory/ledger", async (req) => {
    manager(req.context);
    const q = z
      .object({
        product_id: id.optional(),
        cursor: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return numbers(
      (
        await pool.query(
          "SELECT m.*,p.name FROM stock_movements m JOIN products p ON (p.store_id,p.id)=(m.store_id,m.product_id) WHERE m.store_id=$1 AND ($2::uuid IS NULL OR m.product_id=$2) ORDER BY m.occurred_at DESC,m.id DESC LIMIT $3 OFFSET $4",
          [
            req.context.actor.store_id,
            q.product_id ?? null,
            q.limit,
            cursor(q.cursor),
          ],
        )
      ).rows,
    );
  });
  app.post("/api/v1/inventory/receipts", async (req) =>
    stockWrite(
      pool,
      req.context,
      z
        .object({
          client_event_id: id,
          product_id: id,
          quantity: z.number().int().min(1).max(999999),
          reason,
        })
        .strict()
        .parse(req.body),
      "RECEIPT",
    ),
  );
  app.post("/api/v1/inventory/adjustments", async (req) =>
    stockWrite(
      pool,
      req.context,
      z
        .object({
          client_event_id: id,
          product_id: id,
          counted_quantity: z.number().int().min(0).max(999999),
          expected_version: z.number().int().positive(),
          reason,
        })
        .strict()
        .parse(req.body),
      "ADJUSTMENT",
    ),
  );
  app.get("/api/v1/shifts/current", async (req) =>
    currentShift(pool, req.context),
  );
  app.post("/api/v1/shifts", async (req, reply) => {
    const p = z
      .object({ device_id: id, opening_float_minor: money })
      .strict()
      .parse(req.body);
    return reply
      .code(201)
      .send(
        await newShift(pool, req.context, p.device_id, p.opening_float_minor),
      );
  });
  app.post("/api/v1/shifts/:id/offline-permit", async (req) =>
    issuePermit(
      pool,
      req.context,
      id.parse((req.params as { id: string }).id),
      config.secret,
    ),
  );
  app.post("/api/v1/shifts/:id/count", async (req) => {
    const sid = id.parse((req.params as { id: string }).id);
    const p = z
      .object({ counted_minor: money, reason: z.string().max(500).optional() })
      .strict()
      .parse(req.body);
    const s = await currentShift(pool, req.context);
    requireThat(
      s?.id === sid &&
        (s.opened_by === req.context.actor.id ||
          req.context.actor.role === "MANAGER"),
      "FORBIDDEN",
      403,
    );
    await pool.query(
      "INSERT INTO shift_counts(store_id,shift_id,counted_minor,reason) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,shift_id) DO UPDATE SET counted_minor=$3,reason=$4,updated_at=now()",
      [req.context.actor.store_id, sid, p.counted_minor, p.reason ?? null],
    );
    return p;
  });
  app.post("/api/v1/shifts/:id/reconcile", async (req) => {
    const p = z
      .object({
        device_id: id,
        sale_ids: z.array(id).max(10000),
        pending_count: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    return reconcile(
      pool,
      req.context,
      id.parse((req.params as { id: string }).id),
      p.device_id,
      p.sale_ids,
      p.pending_count,
    );
  });
  app.post("/api/v1/shifts/:id/close", async (req) => {
    const p = z
      .object({
        counted_minor: money,
        reason: z.string().max(500).optional(),
        reconciliation_id: id,
      })
      .strict()
      .parse(req.body);
    return closeShift(
      pool,
      req.context,
      id.parse((req.params as { id: string }).id),
      p.counted_minor,
      p.reason,
      p.reconciliation_id,
    );
  });
  app.post("/api/v1/shifts/:id/cash-movements", async (req) => {
    const p = z
      .object({
        client_event_id: id,
        amount_minor: z
          .number()
          .int()
          .min(-1e9)
          .max(1e9)
          .refine((v) => v !== 0),
        reason,
      })
      .strict()
      .parse(req.body);
    return cashMove(
      pool,
      req.context,
      id.parse((req.params as { id: string }).id),
      p.client_event_id,
      p.amount_minor,
      p.reason,
    );
  });
  app.post("/api/v1/sales", async (req, reply) => {
    const r = await postSale(
      pool,
      req.context,
      req.body,
      req.headers["idempotency-key"] as string,
      config.secret,
    );
    if (config.test && req.headers["x-test-drop-response"] === "1") {
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return reply.code(r.status).send(r.body);
  });
  app.get("/api/v1/sales", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        cursor: z.string().max(100).optional(),
        search: z.string().max(80).default(""),
      })
      .parse(req.query);
    return numbers(
      (
        await pool.query(
          "SELECT s.*,p.method FROM sales s JOIN payments p ON (p.store_id,p.sale_id)=(s.store_id,s.id) WHERE s.store_id=$1 AND (s.receipt_no ILIKE $2 OR s.client_sale_id::text ILIKE $2) ORDER BY s.posted_at DESC,s.id DESC LIMIT $3 OFFSET $4",
          [
            req.context.actor.store_id,
            `%${q.search}%`,
            q.limit,
            q.cursor ? cursor(q.cursor) : q.offset,
          ],
        )
      ).rows,
    );
  });
  app.get("/api/v1/sales/:id", async (req) => {
    const sid = id.parse((req.params as { id: string }).id);
    const sale = (
      await pool.query("SELECT * FROM sales WHERE store_id=$1 AND id=$2", [
        req.context.actor.store_id,
        sid,
      ])
    ).rows[0];
    requireThat(sale, "NOT_FOUND", 404);
    return numbers({
      ...sale,
      lines: (
        await pool.query(
          "SELECT l.*,coalesce((SELECT sum(quantity) FROM refund_lines WHERE store_id=l.store_id AND original_sale_line_id=l.id),0) AS returned FROM sale_lines l WHERE l.store_id=$1 AND l.sale_id=$2 ORDER BY position",
          [req.context.actor.store_id, sid],
        )
      ).rows,
      payment: (
        await pool.query(
          "SELECT method,amount_applied_minor,tender_minor,change_minor,external_reference FROM payments WHERE store_id=$1 AND sale_id=$2",
          [req.context.actor.store_id, sid],
        )
      ).rows[0],
      refunds: (
        await pool.query(
          "SELECT id,total_minor,reason,posted_at FROM refunds WHERE store_id=$1 AND original_sale_id=$2",
          [req.context.actor.store_id, sid],
        )
      ).rows,
    });
  });
  app.post("/api/v1/refunds", async (req, reply) => {
    const r = await postRefund(
      pool,
      req.context,
      req.body,
      req.headers["idempotency-key"] as string,
    );
    return reply.code(r.status).send(r.body);
  });
  app.get("/api/v1/refunds/:id", async (req) => {
    manager(req.context);
    const refund = (
      await pool.query("SELECT * FROM refunds WHERE store_id=$1 AND id=$2", [
        req.context.actor.store_id,
        id.parse((req.params as { id: string }).id),
      ])
    ).rows[0];
    requireThat(refund, "NOT_FOUND", 404);
    return numbers({
      ...refund,
      lines: (
        await pool.query(
          "SELECT * FROM refund_lines WHERE store_id=$1 AND refund_id=$2",
          [req.context.actor.store_id, refund.id],
        )
      ).rows,
    });
  });
  app.get("/api/v1/sync/catalogue", async (req) => {
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        cursor: z.string().max(80).optional(),
      })
      .parse(req.query);
    const v = (
      await pool.query("SELECT catalogue_version FROM stores WHERE id=$1", [
        req.context.actor.store_id,
      ])
    ).rows[0].catalogue_version;
    if (q.cursor)
      requireThat(
        q.cursor === String(v),
        "VERSION_CONFLICT",
        409,
        "Catalogue revision changed; restart the snapshot",
      );
    const items = await catalogue(pool, req.context, true, 100, q.offset);
    return {
      items,
      cursor: String(v),
      next_offset: items.length === 100 ? q.offset + 100 : null,
      server_time: new Date().toISOString(),
      full_snapshot: true,
    };
  });
  app.get("/api/v1/sync/status", async (req) => ({
    server_time: new Date().toISOString(),
    quarantine_count: Number(
      (
        await pool.query(
          "SELECT count(*) FROM sync_quarantine WHERE store_id=$1 AND resolved_at IS NULL",
          [req.context.actor.store_id],
        )
      ).rows[0].count,
    ),
  }));
  app.get("/api/v1/reports/daily", async (req) => {
    manager(req.context);
    const q = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(req.query);
    const date =
      q.date ??
      (
        await pool.query(
          "SELECT (now() AT TIME ZONE timezone)::date::text AS date FROM stores WHERE id=$1",
          [req.context.actor.store_id],
        )
      ).rows[0].date;
    const s = (
      await pool.query(
        "SELECT coalesce(sum(total_minor),0) AS gross_minor,count(*) AS orders FROM sales WHERE store_id=$1 AND business_date=$2",
        [req.context.actor.store_id, date],
      )
    ).rows[0];
    const refunds = Number(
      (
        await pool.query(
          "SELECT coalesce(sum(total_minor),0) AS total FROM refunds WHERE store_id=$1 AND business_date=$2",
          [req.context.actor.store_id, date],
        )
      ).rows[0].total,
    );
    return {
      business_date: date,
      gross_minor: Number(s.gross_minor),
      refunds_minor: refunds,
      net_minor: Number(s.gross_minor) - refunds,
      orders: Number(s.orders),
      average_minor: Number(s.orders)
        ? Math.round(Number(s.gross_minor) / Number(s.orders))
        : 0,
      low_stock: (await catalogue(pool, req.context)).filter(
        (p) => p.quantity <= p.low_stock_threshold,
      ),
    };
  });
  app.post("/api/v1/sync/register", async (req) => {
    const s = saleCommand.parse(req.body);
    requireThat(!s.was_offline, "VALIDATION_ERROR");
    return transaction(pool, async (db) => {
      const shift = (
        await db.query(
          "SELECT id FROM shifts WHERE store_id=$1 AND id=$2 AND device_id=$3 AND opened_by=$4 AND state='OPEN' FOR UPDATE",
          [
            req.context.actor.store_id,
            s.shift_id,
            s.device_id,
            req.context.actor.id,
          ],
        )
      ).rows[0];
      requireThat(shift, "SHIFT_NOT_OPEN", 409);
      const hash = digest(canonical(s));
      await db.query(
        "INSERT INTO terminal_documents(store_id,shift_id,device_id,client_sale_id,payload_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          req.context.actor.store_id,
          s.shift_id,
          s.device_id,
          s.client_sale_id,
          hash,
        ],
      );
      const prior = (
        await db.query(
          "SELECT payload_sha256 FROM terminal_documents WHERE store_id=$1 AND client_sale_id=$2",
          [req.context.actor.store_id, s.client_sale_id],
        )
      ).rows[0];
      requireThat(prior.payload_sha256 === hash, "IDEMPOTENCY_CONFLICT", 409);
      return { registered: true };
    });
  });
  app.get("/api/v1/sync/review", async (req) => {
    manager(req.context);
    return (
      await pool.query(
        "SELECT id,client_document_id,reason_code,payload,created_at FROM sync_quarantine WHERE store_id=$1 AND resolved_at IS NULL ORDER BY created_at LIMIT 100",
        [req.context.actor.store_id],
      )
    ).rows;
  });
  app.post("/api/v1/sync/review/:id/resolve", async (req) => {
    manager(req.context);
    const q = z
      .object({ reason, external_reference: z.string().trim().min(1).max(120) })
      .strict()
      .parse(req.body);
    const qid = id.parse((req.params as { id: string }).id);
    return transaction(pool, async (db) => {
      const row = (
        await db.query(
          "SELECT id FROM sync_quarantine WHERE store_id=$1 AND id=$2 AND resolved_at IS NULL FOR UPDATE",
          [req.context.actor.store_id, qid],
        )
      ).rows[0];
      requireThat(row, "NOT_FOUND", 404);
      await db.query(
        "UPDATE sync_quarantine SET resolved_at=now(),resolved_by=$3,resolution_reason=$4,resolution_reference=$5 WHERE store_id=$1 AND id=$2",
        [
          req.context.actor.store_id,
          qid,
          req.context.actor.id,
          q.reason,
          q.external_reference,
        ],
      );
      await audit(
        db,
        req.context,
        "RECOVERY_RECONCILED_EXTERNALLY",
        "quarantine",
        qid,
        q.reason,
      );
      return { preserved: true, resolved: true };
    });
  });
  app.get("/api/v1/audit", async (req) => {
    manager(req.context);
    return (
      await pool.query(
        "SELECT action,subject_type,subject_id,reason,occurred_at,request_id FROM audit_events WHERE store_id=$1 ORDER BY occurred_at DESC LIMIT 100",
        [req.context.actor.store_id],
      )
    ).rows;
  });
  if (existsSync(resolve("dist/web"))) {
    await app.register(staticFiles, { root: resolve("dist/web") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply.code(404).send({
            code: "NOT_FOUND",
            message: "Resource not found",
            retryable: false,
            request_id: req.id,
            details: [],
          })
        : reply.sendFile("index.html"),
    );
  }
  return { app, pool };
}
