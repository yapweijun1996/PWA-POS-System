import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, transaction } from "../apps/api/src/db.ts";
import { hashPassword } from "../apps/api/src/passwords.ts";
const url = process.env.DATABASE_URL,
  password = process.env.SETUP_PASSWORD,
  email = process.env.SETUP_EMAIL;
if (!url || !password || password.length < 12 || !email?.includes("@"))
  throw new Error(
    "Provide DATABASE_URL, SETUP_EMAIL and a >=12-character SETUP_PASSWORD through a secret-managed environment",
  );
const pool = database(url);
const input = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    password: z.string().min(12).max(200),
    name: z.string().trim().min(1).max(120),
    currency: z.enum(["SGD", "MYR"]),
    timezone: z.string().min(1).max(80),
    displayName: z.string().trim().min(1).max(100),
  })
  .parse({
    email,
    password,
    name: process.env.SETUP_STORE_NAME ?? "My Store",
    currency: process.env.SETUP_CURRENCY ?? "SGD",
    timezone: process.env.SETUP_TIMEZONE ?? "Asia/Singapore",
    displayName: process.env.SETUP_DISPLAY_NAME ?? "Manager",
  });
const hash = await hashPassword(input.password);
try {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(72129056)");
    if ((await db.query("SELECT id FROM stores")).rowCount)
      throw new Error("Initial setup requires an empty migrated deployment");
    if (
      !(
        await db.query("SELECT 1 FROM pg_timezone_names WHERE name=$1", [
          input.timezone,
        ])
      ).rowCount
    )
      throw new Error("SETUP_TIMEZONE must be a valid PostgreSQL timezone");
    const store = randomUUID(),
      user = randomUUID();
    await db.query(
      "INSERT INTO stores(id,name,currency,timezone) VALUES($1,$2,$3,$4)",
      [store, input.name, input.currency, input.timezone],
    );
    await db.query(
      "INSERT INTO users(id,store_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,'MANAGER',$5)",
      [user, store, input.email, input.displayName, hash],
    );
    await db.query(
      "INSERT INTO categories(id,store_id,name) VALUES($1,$2,'General')",
      [randomUUID(), store],
    );
    await db.query(
      "INSERT INTO devices(id,store_id,name,enrolled_by) VALUES($1,$2,'Main counter',$3)",
      [randomUUID(), store, user],
    );
  });
  console.log("Initial store and manager created. No credentials are printed.");
} finally {
  await pool.end();
}
