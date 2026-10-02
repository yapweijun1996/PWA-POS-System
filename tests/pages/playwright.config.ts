import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const base = process.env.PAGES_BASE_PATH ?? "/PWA-POS-System/";
export default defineConfig({
  testDir: ".",
  testMatch: "demo.spec.ts",
  workers: 1,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(root, "docs/qa/pages-results.json") }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3002" + base,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: root,
    command:
      "vite preview --config apps/pages/vite.config.ts --host 127.0.0.1 --port 3002 --strictPort",
    url: "http://127.0.0.1:3002" + base,
    reuseExistingServer: false,
  },
});
