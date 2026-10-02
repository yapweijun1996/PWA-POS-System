import type pg from "pg";
import { requireThat } from "./db.ts";
import { migrationFiles } from "./migrations.ts";

export const requiredMigrations = [
  "001-core.sql",
  "002-runtime.sql",
  "003-runtime-grants.sql",
  "004-history-row-locks.sql",
  "005-recovery-controls.sql",
  "006-production-security.sql",
  "007-inventory-snapshot.sql",
  "008-quarantine-grants.sql",
];

export async function databaseReady(pool: pg.Pool, production: boolean) {
  const versions = (
    await pool.query("SELECT version FROM schema_migrations ORDER BY version")
  ).rows;
  requireThat(
    requiredMigrations.every((v) => versions.some((r) => r.version === v)),
    "SERVICE_UNAVAILABLE",
    503,
  );
  if (production) {
    const recorded = (
      await pool.query("SELECT version,sha256 FROM schema_migrations")
    ).rows;
    const expected = await migrationFiles();
    requireThat(
      expected.length === recorded.length &&
        expected.every((f) =>
          recorded.some(
            (r) => r.version === f.version && r.sha256 === f.sha256,
          ),
        ),
      "SERVICE_UNAVAILABLE",
      503,
      "Migration checksums differ from this release",
    );
    const role = (
      await pool.query(`SELECT
      NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
      NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) AS nonowner,
      NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS non_db_owner,
      NOT has_schema_privilege(current_user,'public','CREATE') AS no_schema_create,
      NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname<>current_user AND pg_has_role(current_user,other.oid,'MEMBER')) AS no_role_membership,
      NOT EXISTS(SELECT 1 FROM unnest(ARRAY['sales','sale_lines','payments','refunds','refund_lines','refund_payments','stock_movements','cash_movements','audit_events','product_prices']) t WHERE has_table_privilege(current_user,t,'DELETE')) AS no_history_delete
      FROM pg_roles r WHERE rolname=current_user`)
    ).rows[0];
    requireThat(
      role && Object.values(role).every((v) => v === true),
      "SERVICE_UNAVAILABLE",
      503,
      "Production database role is not restricted",
    );
  }
}
