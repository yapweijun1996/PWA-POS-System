import { readdir, readFile } from "node:fs/promises";
import { database } from "../apps/api/src/db.ts";
export async function migrate(url: string) {
  const pool = database(url),
    db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(72129057)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const versions = new Set(
      (await db.query("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    for (const file of (await readdir("infra/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (versions.has(file)) continue;
      const sql = (await readFile(`infra/migrations/${file}`, "utf8"))
        .replace(/^BEGIN;\s*$/gm, "")
        .replace(/^COMMIT;\s*$/gm, "");
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          file,
        ]);
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
