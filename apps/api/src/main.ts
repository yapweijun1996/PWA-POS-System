import { createApp } from "./app.ts";
import { configuration, listenPort } from "./config.ts";
async function start() {
  const config = configuration(),
    port = listenPort();
  const { app } = await createApp(config);
  try {
    await app.listen({
      port,
      host: config.production ? "0.0.0.0" : "127.0.0.1",
    });
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
  console.log(`Counter POS API listening on port ${port}`);
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 20000);
      deadline.unref();
      try {
        await app.close();
        clearTimeout(deadline);
        process.exit(0);
      } catch {
        console.error("Graceful shutdown failed");
        process.exit(1);
      }
    });
}
start().catch(() => {
  console.error(
    "Counter POS startup failed; verify server configuration, database availability and migrations",
  );
  process.exitCode = 1;
});
