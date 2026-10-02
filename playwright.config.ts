import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "docs/qa/browser-results.json" }],
  ],
  use: {
    baseURL: "http://localhost:3001",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "tsx scripts/e2e-server.ts",
    url: "http://localhost:3001/health/ready",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
