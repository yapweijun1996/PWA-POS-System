import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { database, transaction } from "../apps/api/src/db.ts";
export const storeId = "11111111-1111-4111-8111-111111111111";
export const managerId = "22222222-2222-4222-8222-222222222222";
export const cashierId = "33333333-3333-4333-8333-333333333333";
export const deviceId = "0482e915-814d-5024-8ab0-2d27144219ed";
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export async function seed(url: string) {
  if (!/counter_pos_(dev|test)$/.test(new URL(url).pathname.slice(1)))
    throw new Error("Synthetic seed refuses non-demo database");
  const pool = database(url);
  const credentials = {
    manager: randomBytes(24).toString("base64url"),
    cashier: randomBytes(24).toString("base64url"),
  };
  try {
    const created = await transaction(pool, async (db) => {
      if (
        (await db.query("SELECT id FROM stores WHERE id=$1", [storeId]))
          .rowCount
      )
        return false;
      await db.query(
        "INSERT INTO stores(id,name,currency) VALUES($1,'Everyday Store','SGD')",
        [storeId],
      );
      for (const [id, email, name, role, pass] of [
        [
          managerId,
          "manager@example.test",
          "Alex Manager",
          "MANAGER",
          credentials.manager,
        ],
        [
          cashierId,
          "cashier@example.test",
          "Alex Cashier",
          "CASHIER",
          credentials.cashier,
        ],
      ])
        await db.query(
          "INSERT INTO users(id,store_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)",
          [id, storeId, email, name, role, passwordHash(pass)],
        );
      await db.query(
        "INSERT INTO devices(id,store_id,name,enrolled_by) VALUES($1,$2,'Counter 01',$3)",
        [deviceId, storeId, managerId],
      );
      const rows = (await readFile("specs/demo-products.csv", "utf8"))
        .trim()
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.split(","));
      const categories = new Map<string, string>();
      for (const row of rows) {
        const [id, sku, name, category, price, cost, units] = row;
        let categoryId = categories.get(category);
        if (!categoryId) {
          categoryId = randomUUID();
          categories.set(category, categoryId);
          await db.query(
            "INSERT INTO categories(id,store_id,name) VALUES($1,$2,$3)",
            [categoryId, storeId, category],
          );
        }
        await db.query(
          "INSERT INTO products(id,store_id,category_id,sku,name,cost_minor,barcode) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, storeId, categoryId, sku, name, Number(cost), sku],
        );
        await db.query(
          "INSERT INTO product_prices(id,store_id,product_id,catalogue_version,unit_price_minor,created_by,name_snapshot,sku_snapshot) VALUES($1,$2,$3,1,$4,$5,$6,$7)",
          [randomUUID(), storeId, id, Number(price), managerId, name, sku],
        );
        await db.query(
          "INSERT INTO stock_balances(store_id,product_id,quantity) VALUES($1,$2,$3)",
          [storeId, id, Number(units)],
        );
        await db.query(
          "INSERT INTO stock_movements(id,store_id,product_id,movement_type,quantity_delta,admin_event_id,reference,reason,actor_id) VALUES($1,$2,$3,'RECEIPT',$4,$5,'Opening stock','Synthetic opening receipt',$6)",
          [randomUUID(), storeId, id, Number(units), randomUUID(), managerId],
        );
      }
      return true;
    });
    if (!created) return;
    await mkdir(".local", { recursive: true, mode: 0o700 });
    await chmod(".local", 0o700);
    await writeFile(
      new URL(url).pathname.endsWith("_test")
        ? ".local/test-users.json"
        : ".local/demo-users.json",
      JSON.stringify(credentials),
      {
        mode: 0o600,
      },
    );
  } finally {
    await pool.end();
  }
}
if (process.argv[1]?.endsWith("/seed.ts")) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  await seed(process.env.DATABASE_URL);
  console.log(
    "Synthetic store seeded; local credentials kept in .local/demo-users.json",
  );
}
