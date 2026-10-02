import { z } from "zod";
import {
  saleCommand,
  type SaleCommand,
} from "../../../packages/contracts/index.ts";
import { canonical } from "../../../packages/domain/money.ts";
import {
  db,
  hashPayload,
  meta,
  assertWriter,
  externalResolution,
  type Outbox,
} from "./db.ts";
import {
  savedCommands,
  validateSavedCommand,
  type SavedCommand,
} from "./commands.ts";
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
async function recoveryKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}
export async function exportRecovery(passphrase: string): Promise<Blob> {
  if (passphrase.length < 12)
    throw new Error("Use a passphrase of at least 12 characters");
  const snapshot = await db.transaction(
    "r",
    [db.outbox, db.meta],
    async () => ({
      documents: await db.outbox.toArray(),
      commands: await savedCommands(),
    }),
  );
  const content = JSON.stringify({
    schema_version: 2,
    ...snapshot,
    checksum: await hashPayload(snapshot),
  });
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await recoveryKey(passphrase, salt, "encrypt");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(content),
  );
  if (encrypted.byteLength > 8_000_000)
    throw new Error(
      "Recovery package exceeds the supported 8 MB encrypted payload. Preserve this terminal and contact support before clearing storage.",
    );
  return new Blob(
    [
      JSON.stringify({
        version: 1,
        iterations: 250000,
        salt: Array.from(salt),
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(encrypted)),
      }),
    ],
    { type: "application/json" },
  );
}
export async function restoreRecovery(file: File, passphrase: string) {
  if (file.size > 32_000_000) throw new Error("Recovery package exceeds 32 MB");
  const data = envelope.parse(JSON.parse(await file.text()));
  const key = await recoveryKey(
    passphrase,
    new Uint8Array(data.salt),
    "decrypt",
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
    !raw ||
    ![1, 2].includes(raw.schema_version) ||
    !Array.isArray(raw.documents) ||
    raw.documents.length > 10000 ||
    (raw.schema_version === 2 &&
      (!Array.isArray(raw.commands) || raw.commands.length > 3)) ||
    raw.checksum !==
      (await hashPayload(
        raw.schema_version === 1
          ? raw.documents
          : { documents: raw.documents, commands: raw.commands },
      ))
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
    const actor = z.string().uuid().parse(row.actor_id);
    const resolution = row.resolution
      ? externalResolution.parse(row.resolution)
      : undefined;
    if (
      resolution &&
      (resolution.client_sale_id !== payload.client_sale_id ||
        resolution.payload_sha256 !== row.hash)
    )
      throw new Error(
        "Recovery disposition does not match the preserved document",
      );
    documents.push({
      id: payload.client_sale_id,
      payload,
      hash: row.hash,
      actor_id: actor,
      // Reconfirm imported dispositions with the server; never silently repost a reconciled sale.
      state: resolution ? "NEEDS_REVIEW" : "PENDING",
      ...(resolution ? { resolution } : {}),
      attempts: 0,
      next_retry_at: 0,
      created_at: Date.parse(payload.client_created_at),
    });
  }
  if (new Set(documents.map((d) => d.id)).size !== documents.length)
    throw new Error("Duplicate document identity in recovery package");
  const commands: SavedCommand[] = (
    raw.schema_version === 2 ? raw.commands : []
  ).map(validateSavedCommand);
  if (new Set(commands.map((c) => c.key)).size !== commands.length)
    throw new Error("Duplicate saved request slot in recovery package");
  await db.transaction(
    "rw",
    [db.sales, db.lines, db.payments, db.deltas, db.outbox, db.meta],
    async () => {
      await assertWriter();
      for (const command of commands) {
        const prior = await meta<SavedCommand>(command.key);
        if (
          prior &&
          canonical(validateSavedCommand({ ...prior, key: command.key })) !==
            canonical(command)
        )
          throw new Error(
            "A restored request conflicts with the preserved local request",
          );
        if (!prior) await db.meta.add({ key: command.key, value: command });
      }
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
