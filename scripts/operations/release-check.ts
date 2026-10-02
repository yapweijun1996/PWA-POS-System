import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { configuration } from "../../apps/api/src/config.ts";
import { databaseReady } from "../../apps/api/src/readiness.ts";
import { reconcile } from "./postgres.ts";

export async function releaseCheck() {
  assert.equal(
    process.env.NODE_ENV,
    "production",
    "Release checks require production configuration",
  );
  const config = await configuration();
  assert.equal(config.demo, false, "Demo mode must be disabled");
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", () => {});
  try {
    await databaseReady(pool, true);
    const db = await pool.connect();
    try {
      const role = (
        await db.query<{ rolname: string }>("SELECT current_user AS rolname")
      ).rows[0];
      assert.equal(
        role.rolname,
        "counter_pos_app",
        "Serving must use the non-owner runtime role",
      );
      const expected = (await readdir("infra/migrations"))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const actual = (
        await db.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version);
      assert.deepEqual(
        actual,
        expected,
        "Database must match the reviewed migration set",
      );
      await reconcile(db);
    } finally {
      db.release();
    }
    let httpProbe =
      "NOT RUN (provide RELEASE_PROBE_URL after authorized HTTPS deployment)";
    if (process.env.RELEASE_PROBE_URL) {
      const target = new URL(process.env.RELEASE_PROBE_URL);
      assert.equal(
        target.origin,
        new URL(config.origin).origin,
        "Probe must use the configured HTTPS origin",
      );
      const live = await fetch(new URL("/health/live", target), {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      assert.equal(live.status, 200, "HTTPS liveness failed");
      assert.equal(
        ((await live.json()) as { demo: boolean }).demo,
        false,
        "Public demo entry must be disabled",
      );
      assert.ok(
        /max-age=[1-9]\d*/.test(
          live.headers.get("strict-transport-security") ?? "",
        ),
        "HTTPS proxy must emit HSTS",
      );
      const ready = await fetch(new URL("/health/ready", target), {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      assert.equal(ready.status, 200, "HTTPS readiness failed");
      const shell = await fetch(target.origin, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      assert.equal(shell.status, 200, "HTTPS application shell failed");
      assert.ok(
        shell.headers.get("content-security-policy"),
        "Application must emit CSP",
      );
      httpProbe =
        "PASS (TLS validation, liveness/readiness, demo disabled, HSTS, CSP and shell)";
    }
    console.log(
      JSON.stringify({
        status: "PREDEPLOY_CHECKS_PASS",
        runtime_role: "counter_pos_app",
        migration_set: "EXACT_MATCH",
        financial_stock_reconciliation: "PASS",
        http_probe: httpProbe,
        release_revision: process.env.RELEASE_REVISION ?? "unknown",
      }),
    );
  } finally {
    await pool.end();
  }
}
