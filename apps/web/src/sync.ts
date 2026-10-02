import type {
  Product,
  Posted,
  Bootstrap,
} from "../../../packages/contracts/index.ts";
import {
  db,
  lease,
  putMeta,
  assertWriter,
  externalResolution,
  unresolved,
  type ExternalResolution,
  type Outbox,
} from "./db.ts";
import { api, ApiError, probe, setCsrf } from "./api.ts";
let ongoing: Promise<void> | null = null;
let requestedFresh: Promise<void> | null = null;
export async function pullCatalogue() {
  if (!(await lease())) return;
  const saleIds = [...new Set((await db.deltas.toArray()).map((d) => d.sale))];
  if (saleIds.length > 10000)
    throw new Error(
      "Too many local stock documents to reconcile safely. Preserve this terminal and export recovery records.",
    );
  const documents = (
    await db.outbox
      .filter((row) => unresolved(row) || saleIds.includes(row.id))
      .toArray()
  ).map((row) => ({ client_sale_id: row.id, payload_sha256: row.hash }));
  if (documents.length > 10000)
    throw new Error(
      "Too many unresolved local documents to reconcile safely. Preserve this terminal and export recovery records.",
    );
  const products: Product[] = [];
  let offset: number | null = 0,
    cursor: string | undefined;
  let covered: string[] | undefined;
  let resolutions: ExternalResolution[] | undefined;
  while (offset !== null) {
    const page: {
      items: Product[];
      cursor: string;
      next_offset: number | null;
      covered_sale_ids: string[];
      covered_documents: { client_sale_id: string; payload_sha256: string }[];
      resolved_documents: ExternalResolution[];
    } = await api("/sync/catalogue", {
      offset,
      ...(cursor ? { cursor } : {}),
      sale_ids: saleIds,
      documents,
    });
    if (cursor && cursor !== page.cursor)
      throw new ApiError(
        "VERSION_CONFLICT",
        409,
        "Catalogue changed while downloading; retry",
      );
    cursor = page.cursor;
    const ids = [...page.covered_sale_ids].sort();
    const proof = page.covered_documents;
    if (
      ids.some((id) => !saleIds.includes(id)) ||
      new Set(ids).size !== ids.length ||
      new Set(proof.map((value) => value.client_sale_id)).size !==
        proof.length ||
      proof.some(
        (value) =>
          !documents.some(
            (document) =>
              document.client_sale_id === value.client_sale_id &&
              document.payload_sha256 === value.payload_sha256,
          ),
      ) ||
      ids.some((id) => !proof.some((value) => value.client_sale_id === id)) ||
      (covered && JSON.stringify(covered) !== JSON.stringify(ids))
    )
      throw new Error(
        "Invalid stock acknowledgement watermark; the local projection was preserved",
      );
    covered = ids;
    const dispositions = page.resolved_documents
      .map((value) => externalResolution.parse(value))
      .sort((a, b) => a.client_sale_id.localeCompare(b.client_sale_id));
    if (
      new Set(dispositions.map((value) => value.client_sale_id)).size !==
        dispositions.length ||
      dispositions.some(
        (value) =>
          !documents.some(
            (document) =>
              document.client_sale_id === value.client_sale_id &&
              document.payload_sha256 === value.payload_sha256,
          ),
      ) ||
      (resolutions &&
        JSON.stringify(resolutions) !== JSON.stringify(dispositions))
    )
      throw new Error(
        "Invalid recovery disposition; local documents were preserved",
      );
    resolutions = dispositions;
    products.push(...page.items.map(({ cost_minor: _, ...safe }) => safe));
    offset = page.next_offset;
    if (
      products.length > 100000 ||
      (offset !== null && offset <= products.length - page.items.length)
    )
      throw new Error("Catalogue pagination exceeds supported bounds");
  }
  await db.transaction(
    "rw",
    [db.products, db.meta, db.deltas, db.outbox],
    async () => {
      await assertWriter();
      await db.products.clear();
      await db.products.bulkPut(products);
      await putMeta("catalogue_cursor", cursor);
      await putMeta("catalogue_at", new Date().toISOString());
      // Explicit coverage includes server commits whose HTTP acknowledgement was lost.
      for (const id of covered ?? [])
        await db.deltas.where("sale").equals(id).delete();
      for (const resolution of resolutions ?? []) {
        const prior = await db.outbox.get(resolution.client_sale_id);
        if (!prior || prior.hash !== resolution.payload_sha256 || prior.posted)
          throw new Error(
            "Recovery disposition conflicts with the preserved local document",
          );
        await db.outbox.update(prior.id, {
          state: "EXTERNALLY_RESOLVED",
          resolution,
          last_error: undefined,
        });
        await db.deltas.where("sale").equals(prior.id).delete();
      }
    },
  );
}
async function updateOwnedOutbox(id: string, changes: Partial<Outbox>) {
  await db.transaction("rw", [db.outbox, db.meta], async () => {
    await assertWriter();
    await db.outbox.update(id, changes);
  });
}
async function drain(force: boolean) {
  if (!(await lease()) || !(await probe())) return;
  let user: Bootstrap;
  try {
    user = await api<Bootstrap>("/bootstrap");
    setCsrf(user.csrf_token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401)
      await db.outbox
        .filter((o) => unresolved(o) && o.state !== "NEEDS_REVIEW")
        .modify({ state: "AUTH_REQUIRED", last_error: "AUTH_REQUIRED" });
    throw e;
  }
  const items = await db.outbox
    .filter(
      (o) =>
        unresolved(o) &&
        o.state !== "NEEDS_REVIEW" &&
        (force || o.next_retry_at <= Date.now()),
    )
    .toArray();
  for (const item of items) {
    if (!(await lease())) return;
    if (item.actor_id && item.actor_id !== user.user.id) {
      await updateOwnedOutbox(item.id, {
        state: "AUTH_REQUIRED",
        last_error: "ORIGINAL_OPERATOR_REQUIRED",
      });
      continue;
    }
    await updateOwnedOutbox(item.id, { state: "SENDING" });
    try {
      if (!item.payload.was_offline) await api("/sync/register", item.payload);
      const posted = await api<Posted>("/sales", item.payload, {
        "Idempotency-Key": item.id,
      });
      await updateOwnedOutbox(item.id, {
        state: "ACKED",
        posted,
        last_error: undefined,
      });
    } catch (e) {
      const error =
        e instanceof ApiError
          ? e
          : new ApiError("SERVICE_UNAVAILABLE", 0, "Retry required");
      const state: Outbox["state"] =
        error.status === 401
          ? "AUTH_REQUIRED"
          : [400, 403, 404, 409, 422].includes(error.status)
            ? "NEEDS_REVIEW"
            : "RETRY";
      const attempts = item.attempts + 1;
      const wait = Math.max(
        error.retryAfter * 1000,
        Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)) +
          Math.random() * 500,
      );
      await updateOwnedOutbox(item.id, {
        state,
        attempts,
        last_error: error.code,
        next_retry_at: Date.now() + wait,
      });
      if (state === "AUTH_REQUIRED") break;
    }
  }
  await pullCatalogue();
  await putMeta("last_sync", new Date().toISOString());
}
export function synchronize(force = false): Promise<void> {
  if (ongoing) {
    if (!force) return ongoing;
    // Explicit reconciliation needs a snapshot taken after the caller's server action.
    if (!requestedFresh)
      requestedFresh = ongoing
        .catch(() => {})
        .then(() => {
          requestedFresh = null;
          return synchronize(true);
        });
    return requestedFresh;
  }
  ongoing = drain(force).finally(() => {
    ongoing = null;
  });
  return ongoing;
}
