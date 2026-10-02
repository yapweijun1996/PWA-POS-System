import { spawn } from "node:child_process";
import { migrate } from "./migrate.ts";
import { seed } from "./seed.ts";
const url =
  process.env.DATABASE_URL ??
  "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_dev";
await migrate(url);
await seed(url);
const runtime = new URL(process.env.RUNTIME_DATABASE_URL ?? url);
runtime.username = "counter_pos_app";
const env = {
  ...process.env,
  DATABASE_URL: runtime.toString(),
  DEMO_MODE: "1",
  APP_ORIGIN: "http://localhost:5173",
};
const children = [
  spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
    env,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
    { env, stdio: "inherit" },
  ),
];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children)
  child.on("exit", () => {
    stop();
  });
