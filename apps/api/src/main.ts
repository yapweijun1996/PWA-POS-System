import { createApp } from "./app.ts";
import { configuration } from "./config.ts";
const { app } = await createApp(configuration());
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
});
console.log(`Counter POS API listening on port ${process.env.PORT ?? 3000}`);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
