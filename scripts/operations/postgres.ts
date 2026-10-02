import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import type { BackupManifest } from "./envelope.ts";

export function postgresEnvironment(connection: string): NodeJS.ProcessEnv {
  const url = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname.slice(1)
  )
    throw new Error("A complete PostgreSQL connection URL is required");
  const allowed: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    connect_timeout: "PGCONNECT_TIMEOUT",
  };
  const extra: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (!allowed[name])
      throw new Error(`Unsupported PostgreSQL URL option: ${name}`);
    extra[allowed[name]] = value;
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "counter-pos-operations",
    ...extra,
  };
}

export function command(
  commandName: string,
  args: string[],
  connection: string,
) {
  const executable = process.env.PG_BIN
    ? join(process.env.PG_BIN, commandName)
    : commandName;
  const child = spawn(executable, ["--no-password", ...args], {
    env: postgresEnvironment(connection),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // CLI diagnostics may contain SQL/business data. Never echo them to shared logs.
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    if (diagnostics.length < 16384) diagnostics += String(chunk);
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(new Error(`${commandName} could not start`)),
    );
    child.once("close", (code) => {
      if (code === 0) return resolve();
      const category = diagnostics
        .split(/\r?\n/)
        .find((line) => /^(?:pg_restore|pg_dump): error:/.test(line));
      const safe = category
        ?.replace(/postgres(?:ql)?:\/\/\S+/g, "[connection withheld]")
        .replace(/"[^"]*"|'[^']*'/g, "[value withheld]")
        .slice(0, 200);
      reject(
        new Error(
          `${commandName} failed${safe ? ": " + safe : "; diagnostics withheld"}`,
        ),
      );
    });
  });
  return { child, completed };
}

export function quoteIdentifier(name: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new Error("Unexpected database identifier");
  return '"' + name + '"';
}

export function restoreName(name: string) {
  if (!/^counter_pos_restore_[a-z0-9_]{1,40}$/.test(name))
    throw new Error(
      "Restore requires a fresh counter_pos_restore_* database; existing targets are never overwritten",
    );
  return name;
}

export async function manifest(db: pg.PoolClient): Promise<BackupManifest> {
  // Normalize rendering and sort semantics across recovery hosts/timezones.
  await db.query("SET LOCAL TIME ZONE 'UTC'");
  await db.query("SET LOCAL DateStyle='ISO,YMD'");
  await db.query("SET LOCAL extra_float_digits=3");
  const tables = (
    await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result: BackupManifest = { tables: {}, migrations: [] };
  for (const { tablename } of tables) {
    const id = quoteIdentifier(tablename),
      hash = createHash("sha256");
    let rows = 0;
    await db.query(
      `DECLARE counter_digest NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS data FROM public.${id} t ORDER BY row_to_json(t)::text COLLATE "C"`,
    );
    try {
      while (true) {
        const batch = await db.query<{ data: string }>(
          "FETCH 500 FROM counter_digest",
        );
        if (!batch.rowCount) break;
        for (const row of batch.rows) {
          hash.update(row.data + "\n");
          rows++;
        }
      }
    } finally {
      await db.query("CLOSE counter_digest");
    }
    result.tables[tablename] = { rows, sha256: hash.digest("hex") };
  }
  if (!result.tables.schema_migrations)
    throw new Error("Backup requires an initialized Counter POS schema");
  result.migrations = (
    await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
  ).rows.map((row) => row.version);
  return result;
}

export async function reconcile(db: pg.PoolClient) {
  const queries = [
    "SELECT b.product_id FROM stock_balances b WHERE b.quantity<>(SELECT coalesce(sum(quantity_delta),0) FROM stock_movements m WHERE (m.store_id,m.product_id)=(b.store_id,b.product_id))",
    "SELECT s.id FROM sales s WHERE s.total_minor<>(SELECT coalesce(sum(amount_applied_minor),0) FROM payments p WHERE (p.store_id,p.sale_id)=(s.store_id,s.id)) OR s.total_minor<>(SELECT coalesce(sum(line_total_minor),0) FROM sale_lines l WHERE (l.store_id,l.sale_id)=(s.store_id,s.id))",
    "SELECT l.id FROM sale_lines l WHERE l.quantity<(SELECT coalesce(sum(quantity),0) FROM refund_lines r WHERE (r.store_id,r.original_sale_line_id)=(l.store_id,l.id)) OR l.line_total_minor<(SELECT coalesce(sum(total_minor),0) FROM refund_lines r WHERE (r.store_id,r.original_sale_line_id)=(l.store_id,l.id))",
    "SELECT r.id FROM refunds r WHERE r.total_minor<>(SELECT coalesce(sum(total_minor),0) FROM refund_lines l WHERE (l.store_id,l.refund_id)=(r.store_id,r.id)) OR r.total_minor<>(SELECT coalesce(sum(amount_minor),0) FROM refund_payments p WHERE (p.store_id,p.refund_id)=(r.store_id,r.id))",
  ];
  for (const sql of queries) {
    if ((await db.query(sql)).rowCount)
      throw new Error("Financial or stock reconciliation failed");
  }
}
