import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { decryptBackup, fileSha256 } from "./envelope.ts";
import {
  command,
  manifest,
  quoteIdentifier,
  reconcile,
  restoreName,
} from "./postgres.ts";
import { secret } from "./secrets.ts";

export async function restoreBackup() {
  process.umask(0o077);
  const input = process.env.BACKUP_FILE;
  const keyFile = process.env.RESTORE_PRIVATE_KEY_FILE;
  const target = restoreName(process.env.RESTORE_DATABASE_NAME ?? "");
  if (!input || !keyFile || process.env.RESTORE_PRIVATE_KEY)
    throw new Error(
      "Provide BACKUP_FILE and RESTORE_PRIVATE_KEY_FILE only on an isolated recovery host",
    );
  const connection = (await secret("RESTORE_ADMIN_DATABASE_URL"))!;
  const url = new URL(connection);
  if (url.pathname !== "/postgres")
    throw new Error(
      "Restore admin URL must connect to the postgres maintenance database",
    );
  const sidecar = JSON.parse(await readFile(input + ".json", "utf8")) as {
    encrypted_sha256: string;
    backup_id: string;
  };
  if (
    !/^[a-f0-9]{64}$/.test(sidecar.encrypted_sha256) ||
    (await fileSha256(input)) !== sidecar.encrypted_sha256
  )
    throw new Error(
      "Encrypted backup checksum does not match the retained metadata",
    );
  const folder = await mkdtemp(join(tmpdir(), "counter-pos-restore-"));
  const recovered = join(folder, "archive.dump");
  const admin = new pg.Pool({
    connectionString: connection,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  admin.on("error", () => {});
  try {
    const privateKey = await readFile(keyFile);
    const passphrase = await secret("RESTORE_PRIVATE_KEY_PASSPHRASE", false);
    let header;
    try {
      header = await decryptBackup(
        input,
        recovered,
        createPrivateKey({ key: privateKey, format: "pem", passphrase }),
      );
    } finally {
      privateKey.fill(0);
    }
    if (header.backup_id !== sidecar.backup_id)
      throw new Error("Retained metadata has a different backup identity");
    const listing = command("pg_restore", ["--list", recovered], connection);
    listing.child.stdout.resume();
    await listing.completed;
    if (
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          target,
        ])
      ).rowCount
    )
      throw new Error(
        "Restore target already exists; no database was modified",
      );
    // The destination is always new. This script never drops, overwrites or promotes it.
    await admin.query(`CREATE DATABASE ${quoteIdentifier(target)}`);
    url.pathname = "/" + target;
    const restore = command(
      "pg_restore",
      [
        "--dbname=" + target,
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        recovered,
      ],
      url.toString(),
    );
    restore.child.stdout.resume();
    await restore.completed;
    const restored = new pg.Pool({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 10000,
    });
    restored.on("error", () => {});
    const db = await restored.connect();
    db.on("error", () => {});
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.deepEqual(
        await manifest(db),
        header.manifest,
        "Restored table counts/digests or migration IDs differ",
      );
      await reconcile(db);
      await db.query("COMMIT");
    } finally {
      db.release();
      await restored.end();
    }
    const result = await open(input + ".restore-result.json", "wx", 0o600);
    try {
      await result.writeFile(
        JSON.stringify(
          {
            status: "ISOLATED_RESTORE_VERIFIED",
            backup_id: header.backup_id,
            verified_at: new Date().toISOString(),
            target_database: target,
            restored_table_counts: Object.fromEntries(
              Object.entries(header.manifest.tables).map(([name, value]) => [
                name,
                value.rows,
              ]),
            ),
            checks: [
              "AES-GCM header/body authentication",
              "Encrypted checksum",
              "Every public table count and SHA-256 digest",
              "Exact migration identities",
              "Sale/refund/payment/stock reconciliation",
            ],
            promotion:
              "NOT PERFORMED; enroll/test runtime credentials and application in the isolated environment before any authorized cutover",
          },
          null,
          2,
        ) + "\n",
      );
      await result.sync();
    } finally {
      await result.close();
    }
    console.log(
      JSON.stringify({
        status: "ISOLATED_RESTORE_VERIFIED",
        backup_id: header.backup_id,
        target_database: target,
      }),
    );
  } finally {
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
}
