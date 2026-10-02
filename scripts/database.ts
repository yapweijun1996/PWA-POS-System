import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(".local/postgres");
const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
function run(command: string, args: string[]) {
  const r = spawnSync(`${bin}/${command}`, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${command} failed`);
}
if (process.argv[2] === "stop") {
  run("pg_ctl", ["-D", dir, "stop", "-m", "fast"]);
} else {
  mkdirSync(resolve(".local"), { recursive: true, mode: 0o700 });
  chmodSync(resolve(".local"), 0o700);
  if (!existsSync(dir)) {
    run("initdb", [
      "-D",
      dir,
      "-U",
      "counter_pos_owner",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "-E",
      "UTF8",
    ]);
  }
  const status = spawnSync(`${bin}/pg_ctl`, ["-D", dir, "status"]);
  if (status.status !== 0)
    run("pg_ctl", [
      "-D",
      dir,
      "-l",
      resolve(".local/postgres.log"),
      "-o",
      `-p 55432 -h 127.0.0.1 -k ${resolve(".local")}`,
      "start",
    ]);
  for (const name of ["counter_pos_dev", "counter_pos_test"]) {
    const check = spawnSync(
      `${bin}/psql`,
      [
        "-h",
        "127.0.0.1",
        "-p",
        "55432",
        "-U",
        "counter_pos_owner",
        "-d",
        "postgres",
        "-tAc",
        `SELECT 1 FROM pg_database WHERE datname='${name}'`,
      ],
      { encoding: "utf8" },
    );
    if (check.status !== 0) throw new Error("Local database connection failed");
    if (check.stdout.trim() !== "1")
      run("createdb", [
        "-h",
        "127.0.0.1",
        "-p",
        "55432",
        "-U",
        "counter_pos_owner",
        name,
      ]);
  }
}
