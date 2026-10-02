import { z } from "zod";
import {
  saleCommand,
  type SaleCommand,
} from "../../../packages/contracts/index.ts";
import { db, hashPayload, writerId, meta, type Outbox } from "./db.ts";
const byteArray = z.array(z.number().int().min(0).max(255));
const envelope = z
  .object({
    version: z.literal(1),
    iterations: z.literal(250000),
    salt: byteArray.length(16),
    iv: byteArray.length(12),
    ciphertext: byteArray.max(8_000_000),
  })
  .strict();
export async function restoreRecovery(file: File, passphrase: string) {
  if (file.size > 32_000_000) throw new Error("Recovery package exceeds 32 MB");
  const data = envelope.parse(JSON.parse(await file.text()));
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(data.salt),
      iterations: data.iterations,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(data.iv) },
      key,
      new Uint8Array(data.ciphertext),
    );
  } catch {
    throw new Error("Incorrect passphrase or corrupted recovery package");
  }
  const raw = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    raw.schema_version !== 1 ||
    !Array.isArray(raw.documents) ||
    raw.documents.length > 10000 ||
    raw.checksum !== (await hashPayload(raw.documents))
  )
    throw new Error("Recovery package checksum or schema is invalid");
  const documents: Outbox[] = [];
  for (const row of raw.documents) {
    const payload: SaleCommand = saleCommand.parse(row.payload);
    if (
      row.id !== payload.client_sale_id ||
      row.hash !== (await hashPayload(payload))
    )
      throw new Error("Document identity or checksum is invalid");
    documents.push({
      id: payload.client_sale_id,
      payload,
      hash: row.hash,
      actor_id: row.actor_id,
      state: "PENDING",
      attempts: 0,
      next_retry_at: 0,
      created_at: Date.parse(payload.client_created_at),
    });
  }
  if (new Set(documents.map((d) => d.id)).size !== documents.length)
    throw new Error("Duplicate document identity in recovery package");
  await db.transaction(
    "rw",
    [db.sales, db.lines, db.payments, db.deltas, db.outbox, db.meta],
    async () => {
      const writer = await meta<{ owner: string; expires: number }>("writer");
      if (writer?.owner !== writerId || writer.expires < Date.now())
        throw new Error("Use the writable terminal tab for recovery");
      for (const document of documents) {
        const prior = await db.outbox.get(document.id);
        if (prior) {
          if (prior.hash !== document.hash)
            throw new Error(
              "A restored identity conflicts with the preserved local record",
            );
          continue;
        }
        await db.sales.add(document.payload);
        await db.lines.bulkAdd(
          document.payload.lines.map((l) => ({
            ...l,
            id: l.line_id,
            sale: document.id,
          })),
        );
        await db.payments.add({
          ...document.payload.payment,
          id: document.id,
          sale: document.id,
        });
        await db.deltas.bulkAdd(
          document.payload.lines.map((l) => ({
            id: l.line_id,
            sale: document.id,
            product: l.product_id,
            quantity: -l.quantity,
          })),
        );
        await db.outbox.add(document);
      }
    },
  );
  return documents.length;
}
