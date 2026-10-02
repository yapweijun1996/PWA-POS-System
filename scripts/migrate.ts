import { database } from "../apps/api/src/db.ts";
import { migrationFiles } from "../apps/api/src/migrations.ts";
export async function migrate(url: string) {
  const pool = database(url),
    db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(72129057)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version varchar(100) PRIMARY KEY, sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), checksum_baselined_at timestamptz, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 char(64), ADD COLUMN IF NOT EXISTS checksum_baselined_at timestamptz",
    );
    const files = await migrationFiles();
    const versions = new Map(
      (await db.query("SELECT version,sha256 FROM schema_migrations")).rows.map(
        (r) => [r.version, r.sha256],
      ),
    );
    if (
      [...versions.keys()].some(
        (version) => !files.some((f) => f.version === version),
      )
    )
      throw new Error("Database contains migrations missing from this release");
    for (const file of files) {
      if (!versions.has(file.version)) continue;
      if (!versions.get(file.version)) {
        if (process.env.BASELINE_LEGACY_MIGRATIONS !== "1")
          throw new Error(
            "Legacy migration checksums require reviewed BASELINE_LEGACY_MIGRATIONS=1; this records current files, not proof of previously executed SQL",
          );
        await db.query(
          "UPDATE schema_migrations SET sha256=$2,checksum_baselined_at=now() WHERE version=$1 AND sha256 IS NULL",
          [file.version, file.sha256],
        );
      } else if (versions.get(file.version) !== file.sha256)
        throw new Error(
          "Applied migration checksum differs from this release; append a new migration instead of editing history",
        );
    }
    for (const file of files) {
      if (versions.has(file.version)) continue;
      const sql = file.sql
        .replace(/^BEGIN;\s*$/gm, "")
        .replace(/^COMMIT;\s*$/gm, "");
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query(
          "INSERT INTO schema_migrations(version,sha256) VALUES($1,$2)",
          [file.version, file.sha256],
        );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(72129057)").catch(() => {});
    db.release();
    await pool.end();
  }
}
if (process.argv[1]?.endsWith("/migrate.ts")) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  await migrate(process.env.DATABASE_URL);
  console.log("Migrations applied");
}
