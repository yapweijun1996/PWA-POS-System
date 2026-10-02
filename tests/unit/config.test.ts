import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scryptSync } from "node:crypto";
import { configuration, listenPort } from "../../apps/api/src/config.ts";
import { hashPassword, passwordMatches } from "../../apps/api/src/passwords.ts";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://counter_pos_app@localhost/counter_pos_dev",
  );
  vi.stubEnv("DATABASE_URL_FILE", "");
  vi.stubEnv("PERMIT_SECRET_FILE", "");
  vi.stubEnv("APP_ORIGIN", "http://localhost:5173");
  vi.stubEnv("PERMIT_SECRET", "");
  vi.stubEnv("DEMO_MODE", "0");
});
afterEach(() => vi.unstubAllEnvs());
test("Production rejects HTTP, missing secrets and demo mode", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://counter_pos_app@localhost/pos");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("PERMIT_SECRET", "");
  vi.stubEnv("DEMO_MODE", "0");
  expect(() => configuration()).toThrow();
  vi.stubEnv("APP_ORIGIN", "https://pos.example.test");
  vi.stubEnv("PERMIT_SECRET", "synthetic-test-signing-secret-32-characters");
  expect(configuration().production).toBe(true);
  vi.stubEnv("DEMO_MODE", "1");
  expect(() => configuration()).toThrow();
});
test("Synthetic demo mode refuses a real database name", () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATABASE_URL", "postgresql://counter_pos_app@localhost/retail");
  vi.stubEnv("DEMO_MODE", "1");
  expect(() => configuration()).toThrow();
});
test("Origins reject credentials, URL paths, queries and fragments", () => {
  for (const origin of [
    "https://user:password@pos.example.test",
    "https://pos.example.test/register",
    "https://pos.example.test?next=elsewhere",
    "https://pos.example.test#register",
    "javascript:alert(1)",
  ]) {
    vi.stubEnv("APP_ORIGIN", origin);
    expect(() => configuration()).toThrow("APP_ORIGIN");
  }
  vi.stubEnv("APP_ORIGIN", "https://pos.example.test/");
  expect(configuration().origin).toBe("https://pos.example.test");
});
test("Production rejects owner credentials and local fallback signing keys", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", "https://pos.example.test");
  vi.stubEnv("PERMIT_SECRET", "f".repeat(64));
  vi.stubEnv("DATABASE_URL", "postgresql://owner@localhost/retail");
  expect(() => configuration()).toThrow("counter_pos_app");
  vi.stubEnv("DATABASE_URL", "postgresql://counter_pos_app@localhost/retail");
  vi.stubEnv("PERMIT_SECRET", "local-only-not-a-production-signing-key");
  expect(() => configuration()).toThrow();
});
test("Demo data and environment flags fail closed", () => {
  vi.stubEnv("DEMO_MODE", "1");
  for (const url of [
    "postgresql://counter_pos_app@db.example.test/counter_pos_dev",
    "postgresql://counter_pos_app@localhost/not_counter_pos_dev",
    "https://localhost/counter_pos_dev",
  ]) {
    vi.stubEnv("DATABASE_URL", url);
    expect(() => configuration()).toThrow();
  }
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://counter_pos_app@localhost/counter_pos_dev",
  );
  vi.stubEnv("DEMO_MODE", "true");
  expect(() => configuration()).toThrow("DEMO_MODE");
  vi.stubEnv("DEMO_MODE", "0");
  vi.stubEnv("NODE_ENV", "prod");
  expect(() => configuration()).toThrow("NODE_ENV");
});
test("Mounted secret files work without ambiguous environment precedence", () => {
  const directory = mkdtempSync(join(tmpdir(), "counter-pos-config-"));
  try {
    const database = join(directory, "database"),
      secret = join(directory, "permit");
    writeFileSync(database, "postgresql://counter_pos_app@localhost/retail\n", {
      mode: 0o600,
    });
    writeFileSync(secret, "d".repeat(64) + "\n", { mode: 0o600 });
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL_FILE", database);
    vi.stubEnv("PERMIT_SECRET_FILE", secret);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://pos.example.test");
    const config = configuration();
    expect(config.databaseUrl).toBe(
      "postgresql://counter_pos_app@localhost/retail",
    );
    expect(config.secret).toHaveLength(64);
    vi.stubEnv("PERMIT_SECRET", "e".repeat(64));
    expect(() => configuration()).toThrow("not both");
    vi.stubEnv("PERMIT_SECRET", "");
    vi.stubEnv("PERMIT_SECRET_FILE", join(directory, "missing"));
    expect(() => configuration()).toThrow("readable nonempty secret file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("Listening ports reject silent invalid values", () => {
  expect(listenPort(undefined)).toBe(3000);
  expect(listenPort("65535")).toBe(65535);
  for (const value of ["0", "65536", "-1", "3000.5", "3e3", "3000junk", ""])
    expect(() => listenPort(value)).toThrow();
});
test("Async password KDF verifies new and existing credentials and rejects malformed hashes", async () => {
  const password = "Synthetic-test-password-2026";
  const hash = await hashPassword(password);
  expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
  expect(await passwordMatches(password, hash)).toBe(true);
  expect(await passwordMatches("different-password", hash)).toBe(false);
  const salt = "0".repeat(32),
    legacy = salt + ":" + scryptSync(password, salt, 64).toString("hex");
  expect(await passwordMatches(password, legacy)).toBe(true);
  expect(await passwordMatches(password, "broken:hash")).toBe(false);
  expect(
    await passwordMatches(password, hash.replace("32768", "999999999")),
  ).toBe(false);
});
