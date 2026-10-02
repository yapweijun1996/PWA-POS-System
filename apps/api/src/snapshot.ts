import type pg from "pg";
import { z } from "zod";
import { catalogue } from "./catalogue.ts";
import { requireThat } from "./db.ts";
import type { Context } from "./context.ts";

export const snapshotQuery = z
  .object({
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    cursor: z.string().max(80).optional(),
    sale_ids: z.array(z.string().uuid()).max(10000).default([]),
    documents: z
      .array(
        z
          .object({
            client_sale_id: z.string().uuid(),
            payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(10000)
      .refine(
        (documents) =>
          new Set(documents.map((document) => document.client_sale_id)).size ===
          documents.length,
        "Duplicate document identity",
      )
      .default([]),
  })
  .strict();

export async function catalogueSnapshot(
  pool: pg.Pool,
  ctx: Context,
  body: unknown,
) {
  const q = snapshotQuery.parse(body);
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = (
      await db.query(
        "SELECT catalogue_version,inventory_version FROM stores WHERE id=$1",
        [ctx.actor.store_id],
      )
    ).rows[0];
    const cursor = `${revision.catalogue_version}:${revision.inventory_version}`;
    requireThat(
      !q.cursor || q.cursor === cursor,
      "VERSION_CONFLICT",
      409,
      "Catalogue or stock changed; restart the snapshot",
    );
    const items = await catalogue(db, ctx, true, 100, q.offset);
    const coveredIds = (
      await db.query(
        "SELECT client_sale_id FROM sales WHERE store_id=$1 AND client_sale_id=ANY($2::uuid[])",
        [ctx.actor.store_id, q.sale_ids],
      )
    ).rows.map((r) => r.client_sale_id as string);
    const coveredDocuments = q.documents.length
      ? (
          await db.query(
            `SELECT s.client_sale_id,s.payload_sha256 FROM sales s
       JOIN jsonb_to_recordset($2::jsonb) d(client_sale_id uuid,payload_sha256 text)
       ON s.client_sale_id=d.client_sale_id AND s.payload_sha256=d.payload_sha256
       WHERE s.store_id=$1 ORDER BY s.client_sale_id`,
            [ctx.actor.store_id, JSON.stringify(q.documents)],
          )
        ).rows
      : [];
    const documentAware =
      !!body && typeof body === "object" && Object.hasOwn(body, "documents");
    const covered = documentAware
      ? coveredIds.filter((id) =>
          coveredDocuments.some((doc) => doc.client_sale_id === id),
        )
      : coveredIds;
    const resolved = q.documents.length
      ? (
          await db.query(
            `SELECT q.client_document_id AS client_sale_id,q.payload_sha256,q.id AS resolution_id,
       q.resolved_at,q.resolution_reason AS reason,q.resolution_reference AS external_reference,
       s.id AS canonical_sale_id,s.receipt_no AS canonical_receipt_no
       FROM sync_quarantine q JOIN jsonb_to_recordset($2::jsonb) d(client_sale_id uuid,payload_sha256 text)
       ON q.client_document_id=d.client_sale_id AND q.payload_sha256=d.payload_sha256
       LEFT JOIN sales s ON s.store_id=q.store_id AND s.client_sale_id=q.client_document_id
       WHERE q.store_id=$1 AND q.resolved_at IS NOT NULL ORDER BY q.client_document_id,q.payload_sha256`,
            [ctx.actor.store_id, JSON.stringify(q.documents)],
          )
        ).rows
      : [];
    await db.query("COMMIT");
    return {
      items,
      cursor,
      next_offset: items.length === 100 ? q.offset + 100 : null,
      server_time: new Date().toISOString(),
      full_snapshot: true,
      covered_sale_ids: covered,
      covered_documents: coveredDocuments,
      resolved_documents: resolved,
    };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
