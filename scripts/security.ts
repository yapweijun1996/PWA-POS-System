import assert from "node:assert/strict";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const publicFiles: string[] = [];
async function walk(folder: string) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await walk(path);
    else publicFiles.push(path);
  }
}
await walk("dist/web");
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[\w-]{35}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
];
let sourceCount = 0,
  publicCount = 0;
for (const path of [...new Set([...files, ...publicFiles])]) {
  if (
    !/\.(?:ts|tsx|js|json|yaml|yml|env|md|html|css|sql|example|webmanifest)$/.test(
      path,
    )
  )
    continue;
  const content = await readFile(path, "utf8");
  for (const pattern of patterns)
    assert.ok(
      !pattern.test(content),
      "Credential pattern detected; inspect locally (values withheld)",
    );
  sourceCount++;
  if (path.startsWith("apps/web/") || path.startsWith("dist/web/")) {
    assert.ok(
      !/(?:postgres(?:ql)?:\/\/|PERMIT_SECRET|BEGIN PRIVATE KEY|counter_pos_owner)/.test(
        content,
      ),
      "Server credential configuration detected in public files",
    );
    publicCount++;
  }
}
await mkdir("docs/qa", { recursive: true });
await writeFile(
  "docs/qa/security-results.json",
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      status: "PASS",
      source_files_scanned: sourceCount,
      public_text_files_scanned: publicCount,
      checks: [
        "Known cloud/API/private-key patterns in non-ignored source",
        "No database URLs, owner role or permit configuration in client sources/built assets",
      ],
      scope:
        "Pattern scan and public bundle inspection; not a penetration test or proof against every possible secret format. Fixtures and screenshots use synthetic data.",
    },
    null,
    2,
  ),
);
console.log("PASS source credential-pattern scan and public bundle boundary");
