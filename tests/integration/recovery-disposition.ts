import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  canonical,
  lineMoney,
  saleMoney,
} from "../../packages/domain/money.ts";
import { digest } from "../../apps/api/src/context.ts";
import type {
  Bootstrap,
  Product,
  SaleCommand,
  Shift,
} from "../../packages/contracts/index.ts";

type Headers = Record<string, string>;
export async function runRecoveryDisposition({
  app,
  pool,
  managerHeaders,
  cashierHeaders,
  deviceId,
  check,
}: {
  app: FastifyInstance;
  pool: pg.Pool;
  managerHeaders: Headers;
  cashierHeaders: Headers;
  deviceId: string;
  check: (name: string, task: () => Promise<void>) => Promise<void>;
}) {
  async function request(
    path: string,
    body?: unknown,
    headers = managerHeaders,
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
  const boot = (await request("/bootstrap")).json() as Bootstrap;
  assert.ok(boot.store.currency === "SGD" || boot.store.currency === "MYR");
  const currency: SaleCommand["currency"] = boot.store.currency;
  const categories = (await request("/categories")).json() as { id: string }[];
  const created = await request("/products", {
    name: "AAA Recovery regression",
    sku: `RECOVERY-${randomUUID()}`,
    category_id: categories[0].id,
    unit_price_minor: 100,
  });
  assert.equal(created.statusCode, 201, created.body);
  const productId = created.json().id as string;
  async function product() {
    return (await request("/products"))
      .json()
      .items.find((p: Product) => p.id === productId) as Product;
  }
  async function receive(quantity: number) {
    const result = await request("/inventory/receipts", {
      client_event_id: randomUUID(),
      product_id: productId,
      quantity,
      reason: "Synthetic recovery stock",
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  async function shift() {
    const result = await request("/shifts", {
      device_id: deviceId,
      opening_float_minor: 0,
    });
    assert.equal(result.statusCode, 201, result.body);
    return result.json() as Shift;
  }
  function sale(p: Product, s: Shift, quantity = 1): SaleCommand {
    const money = lineMoney({
      quantity,
      unit_price_minor: p.unit_price_minor,
      discount_minor: 0,
      tax_bps: p.tax_bps,
    });
    const lines = [
      {
        line_id: randomUUID(),
        product_id: p.id,
        price_revision_id: p.price_revision_id,
        sku_snapshot: p.sku,
        name_snapshot: p.name,
        quantity,
        unit_price_minor: p.unit_price_minor,
        discount_minor: 0,
        tax_bps: p.tax_bps,
        tax_minor: money.tax_minor,
        line_total_minor: money.line_total_minor,
      },
    ];
    const totals = saleMoney(lines);
    return {
      schema_version: 1,
      client_sale_id: randomUUID(),
      device_id: deviceId,
      shift_id: s.id,
      currency,
      client_created_at: new Date().toISOString(),
      was_offline: false,
      lines,
      payment: {
        method: "CASH",
        amount_applied_minor: totals.total_minor,
        tender_minor: totals.total_minor,
        change_minor: 0,
      },
      ...totals,
    };
  }
  const post = (document: SaleCommand) =>
    request(
      "/sales",
      document,
      managerHeaders,
      "POST",
      document.client_sale_id,
    );
  const proof = (document: SaleCommand) => ({
    client_sale_id: document.client_sale_id,
    payload_sha256: digest(canonical(document)),
  });
  async function review(document: SaleCommand) {
    const result = (await request("/sync/review"))
      .json()
      .find(
        (q: { client_document_id: string; payload: SaleCommand }) =>
          q.client_document_id === document.client_sale_id &&
          digest(canonical(q.payload)) === proof(document).payload_sha256,
      );
    assert.ok(result, "Rejected payload must be preserved for review");
    return result as { id: string };
  }
  const resolve = (id: string) =>
    request(`/sync/review/${id}/resolve`, {
      reason: "Synthetic physical cash and stock reconciliation",
      external_reference: `QA-${id}`,
    });
  const snapshot = (document: SaleCommand) =>
    request("/sync/catalogue", {
      sale_ids: [document.client_sale_id],
      documents: [proof(document)],
    });
  async function close(s: Shift, ids: string[], amount: number) {
    const ack = await request(`/shifts/${s.id}/reconcile`, {
      device_id: deviceId,
      sale_ids: ids,
      pending_count: 0,
    });
    assert.equal(ack.statusCode, 200, ack.body);
    const result = await request(`/shifts/${s.id}/close`, {
      counted_minor: amount,
      reconciliation_id: ack.json().reconciliation_id,
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  async function manualCorrection(
    s: Shift,
    document: SaleCommand,
    targetQuantity: number,
  ) {
    const cash = await request(`/shifts/${s.id}/cash-movements`, {
      client_event_id: randomUUID(),
      amount_minor: document.total_minor,
      reason: "Recorded external reconciliation cash",
    });
    assert.equal(cash.statusCode, 200, cash.body);
    const p = await product();
    const count = await request("/inventory/adjustments", {
      client_event_id: randomUUID(),
      product_id: productId,
      counted_quantity: targetQuantity,
      expected_version: p.balance_version,
      reason: "Recorded external reconciliation physical count",
    });
    assert.equal(count.statusCode, 200, count.body);
  }
  await receive(6);
  let preservedCaseId: string;
  await check(
    "Online rejected frozen payment can be reconciled without deleting evidence or reposting cash",
    async () => {
      const s = await shift(),
        p = await product(),
        document = sale(p, s),
        hash = proof(document).payload_sha256;
      assert.equal((await request("/sync/register", document)).statusCode, 200);
      const changed = await request(
        `/products/${p.id}`,
        {
          name: p.name,
          sku: p.sku,
          category_id: p.category_id,
          unit_price_minor: 101,
          expected_version: p.version,
        },
        managerHeaders,
        "PATCH",
      );
      assert.equal(changed.statusCode, 200, changed.body);
      const rejected = await post(document);
      assert.equal(rejected.statusCode, 409);
      assert.equal(rejected.json().code, "VERSION_CONFLICT");
      const pendingCase = await review(document),
        before = await snapshot(document);
      preservedCaseId = pendingCase.id;
      assert.deepEqual(before.json().resolved_documents, []);
      assert.equal(
        (
          await request(`/shifts/${s.id}/reconcile`, {
            device_id: deviceId,
            sale_ids: [],
            pending_count: 0,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await request(
            `/sync/review/${pendingCase.id}/resolve`,
            {
              reason: "Forbidden cashier resolution",
              external_reference: "QA",
            },
            cashierHeaders,
          )
        ).statusCode,
        403,
      );
      const altered = { ...document, total_minor: document.total_minor + 1 };
      assert.equal((await post(altered)).json().code, "IDEMPOTENCY_CONFLICT");
      const alteredCase = await review(altered);
      assert.equal(
        (await resolve(alteredCase.id)).statusCode,
        409,
        "Changed content cannot finalize a different frozen document",
      );
      await manualCorrection(s, document, 5);
      const result = await resolve(pendingCase.id);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().canonical_sale_id, null);
      assert.equal(
        (await resolve(pendingCase.id)).statusCode,
        200,
        "Identical resolution retry is safe",
      );
      assert.equal((await resolve(alteredCase.id)).statusCode, 200);
      const after = (await snapshot(document)).json();
      assert.notEqual(after.cursor, before.json().cursor);
      assert.equal(after.resolved_documents.length, 1);
      assert.equal(after.resolved_documents[0].payload_sha256, hash);
      assert.equal(after.resolved_documents[0].canonical_sale_id, null);
      assert.equal(after.resolved_documents[0].canonical_receipt_no, null);
      assert.deepEqual(after.covered_sale_ids, []);
      assert.deepEqual(after.covered_documents, []);
      const wrong = (
        await request("/sync/catalogue", {
          sale_ids: [document.client_sale_id],
          documents: [
            {
              client_sale_id: document.client_sale_id,
              payload_sha256: "0".repeat(64),
            },
          ],
        })
      ).json();
      assert.deepEqual(wrong.resolved_documents, []);
      assert.equal((await post(document)).json().code, "DOCUMENT_RESOLVED");
      assert.equal((await post(altered)).json().code, "DOCUMENT_RESOLVED");
      assert.equal(
        (
          await pool.query("SELECT id FROM sales WHERE client_sale_id=$1", [
            document.client_sale_id,
          ])
        ).rowCount,
        0,
      );
      const stored = (
        await pool.query(
          "SELECT payload,payload_sha256,resolved_at FROM sync_quarantine WHERE id=$1",
          [pendingCase.id],
        )
      ).rows[0];
      assert.equal(digest(canonical(stored.payload)), hash);
      assert.ok(stored.resolved_at);
      assert.equal(
        (
          await pool.query(
            "SELECT id FROM audit_events WHERE subject_id=$1 AND action='RECOVERY_RECONCILED_EXTERNALLY'",
            [pendingCase.id],
          )
        ).rowCount,
        1,
      );
      await close(s, [], document.total_minor);
    },
  );
  await check(
    "Canonical identity conflict resolution proves both payload hash and original receipt",
    async () => {
      const s = await shift(),
        p = await product(),
        document = sale(p, s);
      assert.equal((await request("/sync/register", document)).statusCode, 200);
      const posted = await post(document);
      assert.equal(posted.statusCode, 201, posted.body);
      const changedLines = document.lines.map((line) => ({
        ...line,
        quantity: 2,
        line_total_minor: line.unit_price_minor * 2,
      }));
      const changedTotals = saleMoney(changedLines),
        altered = {
          ...document,
          lines: changedLines,
          ...changedTotals,
          payment: {
            ...document.payment,
            amount_applied_minor: changedTotals.total_minor,
            tender_minor: changedTotals.total_minor,
          },
        };
      assert.equal((await post(altered)).json().code, "IDEMPOTENCY_CONFLICT");
      const before = (await snapshot(altered)).json();
      assert.deepEqual(before.covered_sale_ids, []);
      assert.deepEqual(before.covered_documents, []);
      const pendingCase = await review(altered),
        resolved = await resolve(pendingCase.id);
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.equal(resolved.json().canonical_sale_id, posted.json().sale_id);
      assert.equal(resolved.json().receipt_no, posted.json().receipt_no);
      const disposition = (await snapshot(altered)).json()
        .resolved_documents[0];
      assert.equal(disposition.payload_sha256, proof(altered).payload_sha256);
      assert.equal(disposition.canonical_sale_id, posted.json().sale_id);
      assert.equal(disposition.canonical_receipt_no, posted.json().receipt_no);
      const exact = (await snapshot(document)).json();
      assert.deepEqual(exact.covered_sale_ids, [document.client_sale_id]);
      assert.deepEqual(exact.covered_documents, [proof(document)]);
      assert.equal(
        (
          await pool.query("SELECT id FROM sales WHERE client_sale_id=$1", [
            document.client_sale_id,
          ])
        ).rowCount,
        1,
      );
      await close(s, [document.client_sale_id], document.total_minor);
      assert.equal(
        (await request("/sync/register", document)).statusCode,
        200,
        "Exact known posting can recover acknowledgement after shift closure",
      );
      assert.equal((await post(document)).statusCode, 200);
    },
  );
  await check(
    "Posting and manager disposition share one UUID lock and cannot create an externally resolved duplicate",
    async () => {
      const s = await shift(),
        p = await product(),
        document = sale(p, s, 5);
      assert.equal((await request("/sync/register", document)).statusCode, 200);
      assert.equal((await post(document)).json().code, "STOCK_UNAVAILABLE");
      const pendingCase = await review(document);
      await receive(2);
      const [posted, resolved] = await Promise.all([
        post(document),
        resolve(pendingCase.id),
      ]);
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.ok([201, 409].includes(posted.statusCode), posted.body);
      const count = (
        await pool.query("SELECT id FROM sales WHERE client_sale_id=$1", [
          document.client_sale_id,
        ])
      ).rowCount;
      if (posted.statusCode === 201) {
        assert.equal(count, 1);
        assert.equal(resolved.json().canonical_sale_id, posted.json().sale_id);
      } else {
        assert.equal(posted.json().code, "DOCUMENT_RESOLVED");
        assert.equal(count, 0);
        assert.equal(resolved.json().canonical_sale_id, null);
        await manualCorrection(s, document, 1);
      }
      await close(
        s,
        count ? [document.client_sale_id] : [],
        document.total_minor,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT b.product_id FROM stock_balances b WHERE b.quantity<>(SELECT coalesce(sum(quantity_delta),0) FROM stock_movements m WHERE (m.store_id,m.product_id)=(b.store_id,b.product_id))",
          )
        ).rowCount,
        0,
      );
    },
  );
  await check(
    "Snapshot body supports its documented bounds and malformed transport is a definite rejection",
    async () => {
      const malformed = await app.inject({
        method: "POST",
        url: "/api/v1/sync/catalogue",
        headers: { ...managerHeaders, "content-type": "application/json" },
        payload: "{",
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().retryable, false);
      const unsupported = await app.inject({
        method: "POST",
        url: "/api/v1/sync/catalogue",
        headers: { ...managerHeaders, "content-type": "application/unknown" },
        payload: "unknown",
      });
      assert.equal(unsupported.statusCode, 415);
      assert.equal(unsupported.json().retryable, false);
      const oversized = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        headers: { ...managerHeaders, "content-type": "application/json" },
        payload: JSON.stringify({ large: "x".repeat(300000) }),
      });
      assert.equal(oversized.statusCode, 413);
      assert.equal(oversized.json().retryable, false);
      const documents = Array.from({ length: 10000 }, () => ({
        client_sale_id: randomUUID(),
        payload_sha256: "0".repeat(64),
      }));
      const bounded = await request("/sync/catalogue", {
        sale_ids: documents.map((d) => d.client_sale_id),
        documents,
      });
      assert.equal(bounded.statusCode, 200, bounded.body);
      assert.deepEqual(bounded.json().covered_documents, []);
    },
  );
  await check(
    "Runtime can resolve quarantines but cannot rewrite their original receipt identity or payload",
    async () => {
      for (const column of ["payload", "id", "payload_sha256"]) {
        await assert.rejects(
          () =>
            pool.query(
              `UPDATE sync_quarantine SET ${column}=${column} WHERE id=$1`,
              [preservedCaseId],
            ),
          (error: unknown) => (error as { code?: string }).code === "42501",
        );
      }
      const permissions = (
        await pool.query(
          "SELECT has_column_privilege(current_user,'sync_quarantine','payload','UPDATE') AS payload,has_column_privilege(current_user,'sync_quarantine','resolution_reason','UPDATE') AS resolution",
        )
      ).rows[0];
      assert.equal(permissions.payload, false);
      assert.equal(permissions.resolution, true);
    },
  );
}
