import assert from "node:assert/strict";
import { database } from "../apps/api/src/db.ts";
import { migrate } from "./migrate.ts";
import { seed } from "./seed.ts";
import { createApp } from "../apps/api/src/app.ts";
const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test";
const parsed = new URL(url);
assert.equal(parsed.pathname, "/counter_pos_test");
assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
const pool = database(url);
await pool.query("DROP SCHEMA public CASCADE");
await pool.query("CREATE SCHEMA public");
await pool.end();
await migrate(url);
await seed(url);
parsed.username = "counter_pos_app";
const { app } = await createApp({
  databaseUrl: parsed.toString(),
  origin: "http://localhost:3001",
  secret: "e2e-only-secret-not-for-production",
  demo: true,
  test: true,
  production: false,
});
await app.listen({ host: "127.0.0.1", port: 3001 });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
