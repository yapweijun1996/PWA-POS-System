import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { database } from "../../apps/api/src/db.ts";
import { createApp } from "../../apps/api/src/app.ts";
import { migrate } from "../../scripts/migrate.ts";
import { seed, storeId } from "../../scripts/seed.ts";
import { lineMoney, saleMoney } from "../../packages/domain/money.ts";
import type {
  Product,
  SaleCommand,
  Shift,
  Permit,
} from "../../packages/contracts/index.ts";
export async function runIntegration() {
  const ownerUrl =
    process.env.TEST_DATABASE_URL ??
    "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test";
  const parsed = new URL(ownerUrl);
  assert.equal(
    parsed.pathname,
    "/counter_pos_test",
    "Fixture reset is permitted only for counter_pos_test",
  );
  assert.ok(
    ["127.0.0.1", "localhost"].includes(parsed.hostname),
    "Fixture reset requires loopback",
  );
  const owner = database(ownerUrl);
  await owner.query("DROP SCHEMA public CASCADE");
  await owner.query("CREATE SCHEMA public");
  await migrate(ownerUrl);
  await seed(ownerUrl);
  parsed.username = "counter_pos_app";
  const { app, pool } = await createApp({
    databaseUrl: parsed.toString(),
    origin: "http://localhost:5173",
    secret: "test-only-secret-do-not-use-in-production",
    demo: true,
    test: true,
    production: false,
  });
  const results: { test: string; status: string }[] = [];
  async function check(name: string, task: () => Promise<void>) {
    await task();
    results.push({ test: name, status: "PASS" });
    console.log("PASS", name);
  }
  async function session(role: "MANAGER" | "CASHIER") {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/demo/login",
      headers: { origin: "http://localhost:5173" },
      payload: { role },
    });
    assert.equal(r.statusCode, 200, r.body);
    return {
      cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-csrf-token": r.json().csrf_token,
      origin: "http://localhost:5173",
    };
  }
  const mh = await session("MANAGER"),
    ch = await session("CASHIER");
  async function request(
    path: string,
    body?: unknown,
    headers = mh,
    method = body === undefined ? "GET" : "POST",
    key?: string,
  ) {
    return app.inject({
      method: method as "GET" | "POST" | "PATCH",
      url: "/api/v1" + path,
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const catalogue = (await request("/products")).json().items as Product[];
  const s = (
    await request("/shifts", {
      device_id: "0482e915-814d-5024-8ab0-2d27144219ed",
      opening_float_minor: 10000,
    })
  ).json() as Shift;
  assert.ok(s.id);
  const permit = (
    await request(`/shifts/${s.id}/offline-permit`, {})
  ).json() as Permit;
  assert.ok(permit.id);
  function sale(
    items: { p: Product; q: number; discount?: number }[],
    offline = false,
  ): SaleCommand {
    const lines = items.map(({ p, q, discount = 0 }) => {
      const m = lineMoney({
        quantity: q,
        unit_price_minor: p.unit_price_minor,
        discount_minor: discount,
        tax_bps: p.tax_bps,
      });
      return {
        line_id: randomUUID(),
        product_id: p.id,
        price_revision_id: p.price_revision_id,
        sku_snapshot: p.sku,
        name_snapshot: p.name,
        quantity: q,
        unit_price_minor: p.unit_price_minor,
        discount_minor: discount,
        tax_bps: p.tax_bps,
        tax_minor: m.tax_minor,
        line_total_minor: m.line_total_minor,
      };
    });
    const totals = saleMoney(lines);
    return {
      schema_version: 1,
      client_sale_id: randomUUID(),
      device_id: s.device_id,
      shift_id: s.id,
      currency: "SGD",
      client_created_at: new Date().toISOString(),
      was_offline: offline,
      ...(offline ? { offline_permit_id: permit.id } : {}),
      lines,
      payment: {
        method: "CASH",
        amount_applied_minor: totals.total_minor,
        tender_minor: Math.max(2000, totals.total_minor),
        change_minor: Math.max(2000, totals.total_minor) - totals.total_minor,
      },
      ...totals,
    };
  }
  const find = (sku: string) => catalogue.find((p) => p.sku === sku)!;
  const basket = sale([
    { p: find("DRK-001"), q: 2 },
    { p: find("SNK-001"), q: 1 },
    { p: find("DRK-002"), q: 1 },
  ]);
  let posted: { sale_id: string; receipt_no: string };
  try {
    await check(
      "T01/T02 concurrent canonical checkout posts exactly once",
      async () => {
        const replies = await Promise.all([
          request("/sales", basket, mh, "POST", basket.client_sale_id),
          request("/sales", basket, mh, "POST", basket.client_sale_id),
        ]);
        assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 201]);
        posted = replies[0].json();
        assert.equal(replies[1].json().sale_id, posted.sale_id);
        assert.equal(replies[0].json().total_minor, 1400);
        assert.equal(
          (await pool.query("SELECT count(*) FROM sales")).rows[0].count,
          "1",
        );
        assert.equal(
          (await pool.query("SELECT count(*) FROM payments")).rows[0].count,
          "1",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM stock_movements WHERE movement_type='SALE'",
            )
          ).rows[0].count,
          "3",
        );
        for (const [sku, q] of [
          ["DRK-001", 22],
          ["SNK-001", 17],
          ["DRK-002", 31],
        ] as const)
          assert.equal(
            (
              await pool.query(
                "SELECT b.quantity FROM stock_balances b JOIN products p ON p.id=b.product_id WHERE p.sku=$1",
                [sku],
              )
            ).rows[0].quantity,
            q,
          );
      },
    );
    await check(
      "T04 altered body under same UUID conflicts before recalculation",
      async () => {
        const r = await request(
          "/sales",
          { ...basket, total_minor: 1401 },
          mh,
          "POST",
          basket.client_sale_id,
        );
        assert.equal(r.statusCode, 409);
        assert.equal(r.json().code, "IDEMPOTENCY_CONFLICT");
      },
    );
    await check(
      "T03 actual HTTP response is dropped after COMMIT; stable retry returns original",
      async () => {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        assert.ok(address && typeof address !== "string");
        const lost = sale([{ p: find("DRK-003"), q: 1 }]);
        await assert.rejects(
          fetch(`http://127.0.0.1:${address.port}/api/v1/sales`, {
            method: "POST",
            headers: {
              ...mh,
              "content-type": "application/json",
              "idempotency-key": lost.client_sale_id,
              "x-test-drop-response": "1",
            },
            body: JSON.stringify(lost),
          }),
        );
        const retry = await request(
          "/sales",
          lost,
          mh,
          "POST",
          lost.client_sale_id,
        );
        assert.equal(retry.statusCode, 200);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM sales WHERE client_sale_id=$1",
              [lost.client_sale_id],
            )
          ).rows[0].count,
          "1",
        );
      },
    );
    await check(
      "T12 role projection, CSRF, foreign IDs and mutation immutability",
      async () => {
        assert.ok(
          !(await request("/products", undefined, ch)).body.includes(
            "cost_minor",
          ),
        );
        assert.equal(
          (await request("/products", { name: "Forbidden" }, ch)).statusCode,
          403,
        );
        assert.equal(
          (await request("/inventory/balances", undefined, ch)).statusCode,
          403,
        );
        assert.equal(
          (await request("/sales/" + randomUUID(), undefined, ch)).statusCode,
          404,
        );
        assert.equal(
          (await request("/shifts", {}, { ...mh, "x-csrf-token": "wrong" }))
            .statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              "/shifts",
              {},
              { ...mh, origin: "https://foreign.invalid" },
            )
          ).statusCode,
          403,
        );
        const foreignStore = randomUUID(),
          foreignCategory = randomUUID();
        await owner.query(
          "INSERT INTO stores(id,name,currency) VALUES($1,'Foreign synthetic store','SGD')",
          [foreignStore],
        );
        await owner.query(
          "INSERT INTO categories(id,store_id,name) VALUES($1,$2,'Foreign private category')",
          [foreignCategory, foreignStore],
        );
        assert.ok(
          !(await request("/categories")).body.includes(foreignCategory),
        );
        const foreignProduct = {
          name: "Forbidden foreign link",
          sku: "FOREIGN-LINK",
          category_id: foreignCategory,
          unit_price_minor: 100,
          cost_minor: 0,
          tax_bps: 0,
        };
        assert.equal(
          (await request("/products", foreignProduct)).statusCode,
          404,
        );
        await assert.rejects(
          owner.query(
            "INSERT INTO products(id,store_id,category_id,sku,name) VALUES($1,$2,$3,'FOREIGN-FK','Forbidden foreign link')",
            [randomUUID(), storeId, foreignCategory],
          ),
        );
        await owner.query("DELETE FROM categories WHERE id=$1", [
          foreignCategory,
        ]);
        await owner.query("DELETE FROM stores WHERE id=$1", [foreignStore]);
        await assert.rejects(pool.query("UPDATE sales SET total_minor=0"));
        await assert.rejects(owner.query("DELETE FROM payments"));
      },
    );
    await check(
      "Stock receipt and count retries preserve one ledger movement",
      async () => {
        const product = find("DRK-003");
        const command = {
          client_event_id: randomUUID(),
          product_id: product.id,
          quantity: 2,
          reason: "Synthetic received stock",
        };
        const replies = await Promise.all([
          request("/inventory/receipts", command),
          request("/inventory/receipts", command),
        ]);
        for (const reply of replies)
          assert.equal(reply.statusCode, 200, reply.body);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM stock_movements WHERE admin_event_id=$1",
              [command.client_event_id],
            )
          ).rows[0].count,
          "1",
        );
        assert.equal(
          (await request("/inventory/receipts", { ...command, quantity: 3 }))
            .statusCode,
          409,
        );
      },
    );
    await check(
      "T28 production demo refusal and secure password session",
      async () => {
        const production = await createApp({
          databaseUrl: parsed.toString(),
          origin: "https://pos.example.test",
          secret: "test-only-long-private-production-signing-secret",
          demo: false,
          test: false,
          production: true,
        });
        try {
          assert.equal(
            (
              await production.app.inject({
                method: "POST",
                url: "/api/v1/demo/login",
                headers: { origin: "https://pos.example.test" },
                payload: { role: "MANAGER" },
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (await production.app.inject("/api/v1/products")).statusCode,
            401,
          );
          const credentials = JSON.parse(
            await readFile(".local/test-users.json", "utf8"),
          );
          const login = await production.app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            headers: { origin: "https://pos.example.test" },
            payload: {
              email: "manager@example.test",
              password: credentials.manager,
            },
          });
          assert.equal(login.statusCode, 200);
          const cookie = login.headers["set-cookie"];
          assert.ok(
            typeof cookie === "string" &&
              cookie.includes("HttpOnly") &&
              cookie.includes("Secure") &&
              cookie.includes("SameSite=Strict"),
          );
          assert.equal(
            (
              await production.app.inject({
                method: "POST",
                url: "/api/v1/auth/login",
                headers: { origin: "https://pos.example.test" },
                payload: {
                  email: "manager@example.test",
                  password: "incorrect-synthetic-password",
                },
              })
            ).statusCode,
            401,
          );
        } finally {
          await production.app.close();
        }
      },
    );
    await check(
      "T09 concurrent manager returns cannot refund/restock the final unit twice",
      async () => {
        const l = basket.lines.find(
          (l) => l.product_id === find("SNK-001").id,
        )!;
        const bodies = [0, 1].map(() => ({
          client_refund_id: randomUUID(),
          original_sale_id: posted!.sale_id,
          shift_id: s.id,
          reason: "Synthetic final-unit return",
          method: "CASH",
          lines: [
            { original_sale_line_id: l.line_id, quantity: 1, restock: true },
          ],
        }));
        const replies = await Promise.all(
          bodies.map((b) =>
            request("/refunds", b, mh, "POST", b.client_refund_id),
          ),
        );
        assert.deepEqual(replies.map((r) => r.statusCode).sort(), [201, 409]);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM refund_lines WHERE original_sale_line_id=$1",
              [l.line_id],
            )
          ).rows[0].count,
          "1",
        );
        const successful = replies.find((r) => r.statusCode === 201)!;
        const body = bodies[replies.indexOf(successful)];
        assert.equal(
          (await request("/refunds", body, mh, "POST", body.client_refund_id))
            .statusCode,
          200,
        );
        assert.equal(
          (
            await request(
              "/refunds",
              { ...body, reason: "changed" },
              mh,
              "POST",
              body.client_refund_id,
            )
          ).statusCode,
          409,
        );
      },
    );
    await check(
      "T10/T30 final rounding remainder and damaged returns",
      async () => {
        const command = sale([{ p: find("DRK-002"), q: 3, discount: 1 }]);
        const post = (
          await request("/sales", command, mh, "POST", command.client_sale_id)
        ).json();
        let refunded = 0;
        for (let i = 0; i < 3; i++) {
          const b = {
            client_refund_id: randomUUID(),
            original_sale_id: post.sale_id,
            shift_id: s.id,
            reason: "Damaged partial return",
            method: "CASH",
            lines: [
              {
                original_sale_line_id: command.lines[0].line_id,
                quantity: 1,
                restock: false,
              },
            ],
          };
          const r = await request(
            "/refunds",
            b,
            mh,
            "POST",
            b.client_refund_id,
          );
          assert.equal(r.statusCode, 201, r.body);
          refunded += r.json().total_minor;
        }
        assert.equal(refunded, 539);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM stock_movements WHERE refund_line_id IN(SELECT id FROM refund_lines WHERE original_sale_line_id=$1)",
              [command.lines[0].line_id],
            )
          ).rows[0].count,
          "0",
        );
      },
    );
    await check(
      "T07/T11 price revisions and receipt snapshots remain immutable",
      async () => {
        const p = find("DRK-001");
        const before = (await request("/sales/" + posted!.sale_id)).json();
        const edit = {
          name: "Renamed Cold Brew",
          sku: p.sku,
          barcode: p.barcode,
          category_id: p.category_id,
          unit_price_minor: 500,
          cost_minor: 210,
          tax_bps: 0,
          low_stock_threshold: 6,
          active: true,
          expected_version: p.version,
        };
        assert.equal(
          (await request("/products/" + p.id, edit, mh, "PATCH")).statusCode,
          200,
        );
        const old = sale([{ p, q: 1 }]);
        assert.equal(
          (await request("/sales", old, mh, "POST", old.client_sale_id)).json()
            .code,
          "VERSION_CONFLICT",
        );
        const after = (await request("/sales/" + posted!.sale_id)).json();
        assert.deepEqual(after.lines, before.lines);
        assert.equal(
          (await request("/products/" + p.id, edit, mh, "PATCH")).json().code,
          "VERSION_CONFLICT",
        );
      },
    );
    await check(
      "T08/T22 valid historical offline replay posts shortage with flag; stale counts fail",
      async () => {
        const p = find("DRK-001");
        const balance = (
          await pool.query("SELECT * FROM stock_balances WHERE product_id=$1", [
            p.id,
          ])
        ).rows[0];
        const change = {
          client_event_id: randomUUID(),
          product_id: p.id,
          counted_quantity: 1,
          expected_version: Number(balance.version),
          reason: "Synthetic physical recount",
        };
        assert.equal(
          (await request("/inventory/adjustments", change)).statusCode,
          200,
        );
        assert.equal(
          (
            await request("/inventory/adjustments", {
              ...change,
              client_event_id: randomUUID(),
            })
          ).json().code,
          "VERSION_CONFLICT",
        );
        const offline = sale([{ p, q: 2 }], true);
        const response = await request(
          "/sales",
          offline,
          mh,
          "POST",
          offline.client_sale_id,
        );
        assert.equal(response.statusCode, 201, response.body);
        assert.deepEqual(response.json().review_flags, ["NEGATIVE_STOCK"]);
        assert.equal(
          (
            await pool.query(
              "SELECT quantity FROM stock_balances WHERE product_id=$1",
              [p.id],
            )
          ).rows[0].quantity,
          -1,
        );
      },
    );
    await check(
      "T25 unknown, expired and revoked permits preserve quarantined documents",
      async () => {
        for (const mode of ["unknown", "expired", "revoked"]) {
          const bad = sale([{ p: find("DRK-002"), q: 1 }], true);
          if (mode === "unknown") bad.offline_permit_id = randomUUID();
          if (mode === "expired")
            bad.client_created_at = new Date(
              Date.parse(permit.expires_at) + 1,
            ).toISOString();
          if (mode === "revoked")
            await owner.query(
              "UPDATE offline_permits SET revoked_at=now() WHERE id=$1",
              [permit.id],
            );
          const response = await request(
            "/sales",
            bad,
            mh,
            "POST",
            bad.client_sale_id,
          );
          assert.equal(
            response.json().code,
            "OFFLINE_PERMIT_INVALID",
            response.body,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM sync_quarantine WHERE client_document_id=$1",
                [bad.client_sale_id],
              )
            ).rows[0].count,
            "1",
          );
        }
        await owner.query(
          "UPDATE offline_permits SET revoked_at=NULL WHERE id=$1",
          [permit.id],
        );
      },
    );
    await check(
      "T27 reporting excludes tender and applies refunds to their business date",
      async () => {
        const r = (await request("/reports/daily")).json();
        const sum = Number(
          (await pool.query("SELECT sum(total_minor) AS sum FROM sales"))
            .rows[0].sum,
        );
        assert.equal(r.gross_minor, sum);
        assert.equal(r.refunds_minor, 859);
        assert.equal(r.net_minor, sum - 859);
      },
    );
    await check(
      "T13/T29 cash movements, reconciliation, pending blocker and variance",
      async () => {
        const cash = {
          client_event_id: randomUUID(),
          amount_minor: 500,
          reason: "Synthetic cash in",
        };
        const replies = await Promise.all([
          request(`/shifts/${s.id}/cash-movements`, cash),
          request(`/shifts/${s.id}/cash-movements`, cash),
        ]);
        for (const reply of replies)
          assert.equal(reply.statusCode, 200, reply.body);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM cash_movements WHERE id=$1",
              [cash.client_event_id],
            )
          ).rows[0].count,
          "1",
        );
        assert.equal(
          (
            await request(`/shifts/${s.id}/cash-movements`, {
              ...cash,
              amount_minor: 501,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await request(`/shifts/${s.id}/reconcile`, {
              device_id: s.device_id,
              sale_ids: [],
              pending_count: 1,
            })
          ).statusCode,
          409,
        );
        const ids = (
          await pool.query(
            "SELECT client_sale_id FROM sales ORDER BY client_sale_id",
          )
        ).rows.map((r) => r.client_sale_id);
        assert.equal(
          (
            await request(`/shifts/${s.id}/reconcile`, {
              device_id: s.device_id,
              sale_ids: ids,
              pending_count: 0,
            })
          ).statusCode,
          409,
        );
        for (const quarantined of (await request("/sync/review")).json()) {
          assert.equal(
            (
              await request(`/sync/review/${quarantined.id}/resolve`, {
                reason: "Synthetic transaction documented outside ledger",
                external_reference: "SYNTHETIC-RECOVERY-1",
              })
            ).statusCode,
            200,
          );
        }
        const negative = (
          await pool.query(
            "SELECT product_id,version FROM stock_balances WHERE quantity<0",
          )
        ).rows[0];
        await request("/inventory/adjustments", {
          client_event_id: randomUUID(),
          product_id: negative.product_id,
          expected_version: Number(negative.version),
          counted_quantity: 0,
          reason: "Manager physically reviewed offline shortage",
        });
        const ack = await request(`/shifts/${s.id}/reconcile`, {
          device_id: s.device_id,
          sale_ids: ids,
          pending_count: 0,
        });
        assert.equal(ack.statusCode, 200, ack.body);
        const shift = (await request("/shifts/current")).json();
        const count = shift.expected_cash_minor - 100;
        assert.equal(
          (
            await request(`/shifts/${s.id}/close`, {
              counted_minor: count,
              reconciliation_id: ack.json().reconciliation_id,
            })
          ).statusCode,
          422,
        );
        assert.equal(
          (
            await request(`/shifts/${s.id}/close`, {
              counted_minor: count,
              reason: "Synthetic variance",
              reconciliation_id: ack.json().reconciliation_id,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (await request(`/shifts/${s.id}/cash-movements`, cash)).statusCode,
          200,
          "Exact cash retry survives shift closure",
        );
      },
    );
    await check(
      "all ledger balances, sale line sums and payment amounts reconcile",
      async () => {
        assert.equal(
          (
            await pool.query(
              "SELECT b.product_id FROM stock_balances b WHERE b.quantity<>(SELECT coalesce(sum(quantity_delta),0) FROM stock_movements m WHERE (m.store_id,m.product_id)=(b.store_id,b.product_id))",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT s.id FROM sales s JOIN payments p ON (p.store_id,p.sale_id)=(s.store_id,s.id) WHERE s.total_minor<>p.amount_applied_minor OR s.total_minor<>(SELECT sum(line_total_minor) FROM sale_lines l WHERE (l.store_id,l.sale_id)=(s.store_id,s.id))",
            )
          ).rowCount,
          0,
        );
      },
    );
    await check(
      "health liveness remains independent of schema readiness",
      async () => {
        await owner.query(
          "DELETE FROM schema_migrations WHERE version='005-recovery-controls.sql'",
        );
        assert.equal((await app.inject("/health/live")).statusCode, 200);
        assert.equal((await app.inject("/health/ready")).statusCode, 503);
        await owner.query(
          "INSERT INTO schema_migrations(version) VALUES('005-recovery-controls.sql')",
        );
      },
    );
    await mkdir("docs/qa", { recursive: true });
    await writeFile(
      "docs/qa/integration-results.json",
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          environment: "isolated PostgreSQL 16 / runtime non-owner role",
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    await owner.end();
  }
}
