import { afterEach, expect, test, vi } from "vitest";
import { configuration } from "../../apps/api/src/config.ts";
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
