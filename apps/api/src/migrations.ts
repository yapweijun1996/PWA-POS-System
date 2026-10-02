import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function migrationFiles() {
  const result: { version: string; sha256: string; sql: string }[] = [];
  for (const version of (await readdir("infra/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = (await readFile(`infra/migrations/${version}`, "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    result.push({
      version,
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return result;
}
