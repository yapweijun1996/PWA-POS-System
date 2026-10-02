import { migrate } from "./migrate.ts";
import { seed } from "./seed.ts";
import { createApp } from "../apps/api/src/app.ts";
const ownerUrl =
  process.env.DATABASE_URL ??
  "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_dev";
await migrate(ownerUrl);
await seed(ownerUrl);
const url = new URL(process.env.RUNTIME_DATABASE_URL ?? ownerUrl);
url.username = "counter_pos_app";
const port = Number(process.env.PORT ?? 3000),
  origin = `http://localhost:${port}`;
const { app } = await createApp({
  databaseUrl: url.toString(),
  origin,
  secret: "local-only-not-a-production-signing-key",
  demo: true,
  test: process.env.NODE_ENV === "test",
  production: false,
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic Counter POS demo: ${origin}`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
