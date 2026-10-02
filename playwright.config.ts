import { defineConfig } from "@playwright/test";
const browser = process.env.POS_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(browser))
  throw new Error("POS_BROWSER must be chromium, firefox or webkit");
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          browser === "chromium"
            ? "docs/qa/browser-results.json"
            : `docs/qa/browser-results-${browser}.json`,
      },
    ],
  ],
  use: {
    baseURL: "http://localhost:3001",
    browserName: browser as "chromium" | "firefox" | "webkit",
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
