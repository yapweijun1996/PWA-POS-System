import { randomUUID, scryptSync, randomBytes } from "node:crypto";
import { database, transaction } from "../apps/api/src/db.ts";
const url = process.env.DATABASE_URL,
  password = process.env.SETUP_PASSWORD,
  email = process.env.SETUP_EMAIL;
if (!url || !password || password.length < 12 || !email?.includes("@"))
  throw new Error(
    "Provide DATABASE_URL, SETUP_EMAIL and a >=12-character SETUP_PASSWORD through a secret-managed environment",
  );
const pool = database(url);
const salt = randomBytes(16).toString("hex");
try {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(72129056)");
    if ((await db.query("SELECT id FROM stores")).rowCount)
      throw new Error("Initial setup requires an empty migrated deployment");
    const store = randomUUID(),
      user = randomUUID();
    await db.query(
      "INSERT INTO stores(id,name,currency,timezone) VALUES($1,$2,$3,$4)",
      [
        store,
        process.env.SETUP_STORE_NAME ?? "My Store",
        process.env.SETUP_CURRENCY ?? "SGD",
        process.env.SETUP_TIMEZONE ?? "Asia/Singapore",
      ],
    );
    await db.query(
      "INSERT INTO users(id,store_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,'MANAGER',$5)",
      [
        user,
        store,
        email.toLowerCase().trim(),
        process.env.SETUP_DISPLAY_NAME ?? "Manager",
        salt + ":" + scryptSync(password, salt, 64).toString("hex"),
      ],
    );
  });
  console.log("Initial store and manager created. No credentials are printed.");
} finally {
  await pool.end();
}
