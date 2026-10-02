import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { encryptBackup, fileSha256 } from "./envelope.ts";
import { command, manifest, reconcile } from "./postgres.ts";
import { secret } from "./secrets.ts";

export async function createBackup() {
  process.umask(0o077);
  const connection = (await secret("DATABASE_URL"))!;
  const recipientFile = process.env.BACKUP_RECIPIENT_FILE;
  if (!recipientFile)
    throw new Error(
      "BACKUP_RECIPIENT_FILE must identify an approved public key",
    );
  const recipient = await readFile(recipientFile);
  const folder = resolve(process.env.BACKUP_DIRECTORY ?? ".local/backups");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    path = join(folder, id + ".posbackup");
  const pool = new pg.Pool({
    connectionString: connection,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", () => {});
  const db = await pool.connect();
  db.on("error", () => {});
  let retained = false;
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (
      await db.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() AS snapshot",
      )
    ).rows[0].snapshot;
    const data = await manifest(db);
    await reconcile(db);
    const dump = command(
      "pg_dump",
      ["--format=custom", "--snapshot=" + snapshot, "--lock-wait-timeout=30s"],
      connection,
    );
    try {
      const [header] = await Promise.all([
        encryptBackup(dump.child.stdout, path, recipient, {
          backup_id: id,
          created_at: new Date().toISOString(),
          release_revision: process.env.RELEASE_REVISION ?? "unknown",
          database_name: decodeURIComponent(
            new URL(connection).pathname.slice(1),
          ),
          manifest: data,
        }),
        dump.completed,
      ]);
      const sha256 = await fileSha256(path);
      const metadata = await open(path + ".json", "wx", 0o600);
      try {
        await metadata.writeFile(
          JSON.stringify(
            {
              format: "counter-pos-backup-metadata-v1",
              encrypted_sha256: sha256,
              backup_id: header.backup_id,
              created_at: header.created_at,
              release_revision: header.release_revision,
              recipient_sha256: header.recipient_sha256,
              migrations: header.manifest.migrations,
              verification:
                "Snapshot-consistent digest manifest and financial/stock reconciliation; restore not yet rehearsed",
            },
            null,
            2,
          ) + "\n",
        );
        await metadata.sync();
      } finally {
        await metadata.close();
      }
      await db.query("COMMIT");
      retained = true;
      console.log(
        JSON.stringify({
          status: "BACKUP_RETAINED",
          backup_id: id,
          file: path,
          encrypted_sha256: sha256,
        }),
      );
      return path;
    } finally {
      if (!dump.child.killed && dump.child.exitCode === null)
        dump.child.kill("SIGTERM");
    }
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    db.release();
    await pool.end();
    if (!retained) {
      await unlink(path).catch(() => {});
      await unlink(path + ".json").catch(() => {});
    }
  }
}
