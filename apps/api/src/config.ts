import { readFileSync, statSync } from "node:fs";

export type Config = {
  databaseUrl: string;
  origin: string;
  secret: string;
  demo: boolean;
  test: boolean;
  production: boolean;
};
export function environmentSecret(
  name: "DATABASE_URL" | "PERMIT_SECRET",
): string | undefined {
  const direct = process.env[name],
    file = process.env[`${name}_FILE`];
  if (direct && file)
    throw new Error(`Configure ${name} or ${name}_FILE, not both`);
  if (!file) return direct;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384) throw new Error();
    const value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch {
    throw new Error(
      `${name}_FILE must reference a readable nonempty secret file`,
    );
  }
}
export function configuration(): Config {
  if (
    process.env.NODE_ENV &&
    !["development", "test", "production"].includes(process.env.NODE_ENV)
  )
    throw new Error("NODE_ENV must be development, test or production");
  if (process.env.DEMO_MODE && !["0", "1"].includes(process.env.DEMO_MODE))
    throw new Error("DEMO_MODE must be 0 or 1");
  const production = process.env.NODE_ENV === "production";
  const databaseUrl = environmentSecret("DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  let database: URL, origin: URL;
  try {
    database = new URL(databaseUrl);
    origin = new URL(process.env.APP_ORIGIN ?? "http://localhost:5173");
  } catch {
    throw new Error("DATABASE_URL and APP_ORIGIN must be valid URLs");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname ||
    !database.pathname.slice(1) ||
    database.hash
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "APP_ORIGIN must be an HTTP(S) origin without credentials or a path",
    );
  const demo = process.env.DEMO_MODE === "1";
  const secret = environmentSecret("PERMIT_SECRET");
  if (
    production &&
    (!secret ||
      secret.length < 32 ||
      secret === "local-only-not-a-production-signing-key" ||
      demo ||
      origin.protocol !== "https:" ||
      decodeURIComponent(database.username) !== "counter_pos_app")
  )
    throw new Error(
      "Production requires HTTPS origin, a signing secret, counter_pos_app and disabled demo mode",
    );
  if (
    demo &&
    (!/^counter_pos_(dev|test)$/.test(database.pathname.slice(1)) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname))
  )
    throw new Error(
      "Demo mode requires an isolated loopback counter_pos_dev/test database",
    );
  return {
    databaseUrl,
    origin: origin.origin,
    secret: secret ?? "local-only-not-a-production-signing-key",
    demo,
    test: process.env.NODE_ENV === "test",
    production,
  };
}

export function listenPort(value = process.env.PORT): number {
  if (value === undefined) return 3000;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  return Number(value);
}
