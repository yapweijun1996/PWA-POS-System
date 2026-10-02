import { spawn } from "node:child_process";
// Each launch owns a fresh loopback synthetic database through e2e-server.ts.
const scenarios =
  "canonical cash|offline local commit|quota|mobile safe-area|fresh offline|encrypted recovery|Settings";
for (const browser of ["firefox", "webkit"]) {
  console.log(`Running ${browser} compatibility scenarios`);
  const child = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--grep", scenarios],
    {
      env: { ...process.env, POS_BROWSER: browser },
      stdio: "inherit",
    },
  );
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (status !== 0) {
    process.exitCode = status;
    break;
  }
}
