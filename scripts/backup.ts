import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  constants,
} from "node:crypto";
import {
  mkdir,
  readFile,
  open,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { catalogue } from "../apps/api/src/catalogue.ts";
import { currentShift, newShift } from "../apps/api/src/shifts.ts";
import { postSale } from "../apps/api/src/sales.ts";
import { lineMoney, saleMoney } from "../packages/domain/money.ts";
import type { Actor, SaleCommand } from "../packages/contracts/index.ts";
import { database } from "../apps/api/src/db.ts";
const source =
    process.env.TEST_DATABASE_URL ??
    "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test",
  url = new URL(source);
assert.equal(
  url.pathname,
  "/counter_pos_test",
  "Rehearsal reads only the isolated test database",
);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
const bin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const folder = resolve(".local/backup-rehearsal");
await mkdir(folder, { recursive: true, mode: 0o700 });
process.umask(0o077);
const name = "counter_pos_restore_" + Date.now(),
  id = randomUUID(),
  dump = resolve(folder, id + ".dump"),
  encrypted = resolve(folder, id + ".encrypted"),
  restored = resolve(folder, id + ".restore.dump");
const connection = [
  "-h",
  url.hostname,
  "-p",
  url.port || "5432",
  "-U",
  decodeURIComponent(url.username),
];
const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
function run(command: string, args: string[]) {
  const result = spawnSync(`${bin}/${command}`, args, {
    env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(command + " failed (details withheld)");
  return result.stdout;
}
const admin = database(new URL("/postgres", url).toString());
let targetCreated = false;
async function snapshot(databaseUrl: string) {
  const pool = database(databaseUrl);
  try {
    const tables = [
      "products",
      "product_prices",
      "sales",
      "sale_lines",
      "payments",
      "refunds",
      "refund_lines",
      "refund_payments",
      "stock_movements",
      "audit_events",
    ];
    const counts: Record<string, number> = {};
    for (const table of tables)
      counts[table] = Number(
        (await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0]
          .count,
      );
    const balances = (
      await pool.query(
        "SELECT store_id,product_id,quantity,version FROM stock_balances ORDER BY store_id,product_id",
      )
    ).rows;
    const versions = (
      await pool.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows;
    const receipts = (
      await pool.query(
        "SELECT id,client_sale_id,receipt_no,total_minor,payload_sha256 FROM sales ORDER BY id",
      )
    ).rows;
    assert.equal(
      (
        await pool.query(
          "SELECT b.product_id FROM stock_balances b WHERE b.quantity<>(SELECT coalesce(sum(quantity_delta),0) FROM stock_movements m WHERE (m.store_id,m.product_id)=(b.store_id,b.product_id))",
        )
      ).rowCount,
      0,
      "Stock reconciliation",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT s.id FROM sales s JOIN payments p ON (p.store_id,p.sale_id)=(s.store_id,s.id) WHERE s.total_minor<>p.amount_applied_minor OR s.total_minor<>(SELECT sum(line_total_minor) FROM sale_lines l WHERE (l.store_id,l.sale_id)=(s.store_id,s.id))",
        )
      ).rowCount,
      0,
      "Sale/payment reconciliation",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT l.id FROM sale_lines l WHERE l.quantity<(SELECT coalesce(sum(quantity),0) FROM refund_lines r WHERE (r.store_id,r.original_sale_line_id)=(l.store_id,l.id)) OR l.line_total_minor<(SELECT coalesce(sum(total_minor),0) FROM refund_lines r WHERE (r.store_id,r.original_sale_line_id)=(l.store_id,l.id))",
        )
      ).rowCount,
      0,
      "Refund limits",
    );
    return { counts, balances, versions, receipts };
  } finally {
    await pool.end();
  }
}
try {
  const start = Date.now(),
    before = await snapshot(source);
  run("pg_dump", [
    ...connection,
    "-d",
    url.pathname.slice(1),
    "-Fc",
    "-f",
    dump,
  ]);
  assert.equal((await stat(dump)).mode & 0o777, 0o600);
  assert.ok(run("pg_restore", ["--list", dump]).includes("TABLE public sales"));
  const plaintext = await readFile(dump),
    hash = createHash("sha256").update(plaintext).digest("hex");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv),
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapped = publicEncrypt(
    {
      key: publicKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    key,
  );
  const f = await open(encrypted, "wx", 0o600);
  await f.writeFile(
    JSON.stringify({
      algorithm: "RSA-OAEP-SHA256/AES-256-GCM",
      wrapped_key: wrapped.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
  );
  await f.sync();
  await f.close();
  assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
  await unlink(dump);
  const recoveredKey = privateDecrypt(
    {
      key: privateKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    wrapped,
  );
  const decipher = createDecipheriv("aes-256-gcm", recoveredKey, iv);
  decipher.setAuthTag(cipher.getAuthTag());
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  assert.equal(createHash("sha256").update(decrypted).digest("hex"), hash);
  const restoreFile = await open(restored, "wx", 0o600);
  await restoreFile.writeFile(decrypted);
  await restoreFile.sync();
  await restoreFile.close();
  await admin.query(`CREATE DATABASE ${name}`);
  targetCreated = true;
  run("pg_restore", [...connection, "-d", name, "--exit-on-error", restored]);
  const target = new URL("/" + name, url).toString();
  assert.deepEqual(await snapshot(target), before);
  const runtimeUrl = new URL(target);
  runtimeUrl.username = "counter_pos_app";
  const targetPool = database(runtimeUrl.toString());
  try {
    const actor = (
      await targetPool.query(
        "SELECT id,store_id,display_name,role FROM users WHERE role='MANAGER' ORDER BY created_at LIMIT 1",
      )
    ).rows[0] as Actor;
    const ctx = { actor, requestId: randomUUID() };
    const device = (
      await targetPool.query(
        "SELECT id FROM devices WHERE store_id=$1 AND selling AND revoked_at IS NULL",
        [actor.store_id],
      )
    ).rows[0].id;
    const shift =
      (await currentShift(targetPool, ctx)) ??
      (await newShift(targetPool, ctx, device, 10000));
    const product = (await catalogue(targetPool, ctx)).find(
      (p) => p.active && p.quantity > 0,
    );
    assert.ok(product, "Restored fixture needs a sellable product");
    const amounts = lineMoney({
      quantity: 1,
      unit_price_minor: product.unit_price_minor,
      discount_minor: 0,
      tax_bps: 0,
    });
    const line = {
      line_id: randomUUID(),
      product_id: product.id,
      price_revision_id: product.price_revision_id,
      sku_snapshot: product.sku,
      name_snapshot: product.name,
      quantity: 1,
      unit_price_minor: product.unit_price_minor,
      discount_minor: 0,
      tax_bps: 0,
      tax_minor: amounts.tax_minor,
      line_total_minor: amounts.line_total_minor,
    };
    const totals = saleMoney([line]);
    const command: SaleCommand = {
      schema_version: 1,
      client_sale_id: randomUUID(),
      device_id: device,
      shift_id: shift.id,
      currency: "SGD",
      client_created_at: new Date().toISOString(),
      was_offline: false,
      lines: [line],
      payment: {
        method: "CASH",
        amount_applied_minor: totals.total_minor,
        tender_minor: totals.total_minor,
        change_minor: 0,
      },
      ...totals,
    };
    const posted = await postSale(
      targetPool,
      ctx,
      command,
      command.client_sale_id,
      "restore-only-no-offline",
    );
    const retry = await postSale(
      targetPool,
      ctx,
      command,
      command.client_sale_id,
      "restore-only-no-offline",
    );
    assert.equal(posted.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(posted.body.sale_id, retry.body.sale_id);
    assert.equal(
      Number(
        (
          await targetPool.query(
            "SELECT quantity FROM stock_balances WHERE store_id=$1 AND product_id=$2",
            [actor.store_id, product.id],
          )
        ).rows[0].quantity,
      ),
      product.quantity - 1,
    );
    const after = await snapshot(target);
    assert.equal(after.counts.sales, before.counts.sales + 1);
    assert.equal(after.counts.payments, before.counts.payments + 1);
    assert.equal(
      after.counts.stock_movements,
      before.counts.stock_movements + 1,
    );
  } finally {
    await targetPool.end();
  }
  await mkdir("docs/qa", { recursive: true });
  await writeFile(
    "docs/qa/backup-results.json",
    JSON.stringify(
      {
        test_id: "T19",
        status: "PASS",
        source: "isolated synthetic test database",
        restored_to: "new isolated disposable database",
        archive_sha256: hash,
        mode: "0600",
        encryption:
          "RSA-OAEP-SHA256 / AES-256-GCM; ephemeral in-memory private key",
        counts: before.counts,
        migrations: before.versions,
        financial_and_stock_reconciliation: "PASS",
        post_restore_sale_and_idempotent_retry: "PASS (non-owner runtime role)",
        elapsed_ms: Date.now() - start,
        scope: "Restore rehearsal only; not a retained operational backup",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS encrypted backup / isolated restore / exact identities and ledger reconciliation",
  );
} finally {
  if (targetCreated) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
  for (const file of [dump, restored, encrypted])
    await unlink(file).catch(() => {});
}
