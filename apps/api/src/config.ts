export type Config = {
  databaseUrl: string;
  origin: string;
  secret: string;
  demo: boolean;
  test: boolean;
  production: boolean;
};
export function configuration(): Config {
  const production = process.env.NODE_ENV === "production";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const demo = process.env.DEMO_MODE === "1";
  const secret = process.env.PERMIT_SECRET;
  if (
    production &&
    (!secret ||
      secret.length < 32 ||
      demo ||
      !process.env.APP_ORIGIN?.startsWith("https://"))
  )
    throw new Error(
      "Production requires HTTPS origin, a signing secret and disabled demo mode",
    );
  if (
    demo &&
    !/counter_pos_(dev|test)$/.test(new URL(databaseUrl).pathname.slice(1))
  )
    throw new Error(
      "Demo mode requires an isolated counter_pos_dev/test database",
    );
  return {
    databaseUrl,
    origin: process.env.APP_ORIGIN ?? "http://localhost:5173",
    secret: secret ?? "local-only-not-a-production-signing-key",
    demo,
    test: process.env.NODE_ENV === "test",
    production,
  };
}
