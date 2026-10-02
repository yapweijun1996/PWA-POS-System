import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Product, SaleCommand } from "../../packages/contracts/index.ts";

const execute = promisify(execFile);
process.umask(0o077);
const repository = resolve(".");
await mkdir(".local", { recursive: true, mode: 0o700 });
const folder = await mkdtemp(resolve(".local/production-drill-"));
const project = "counter-pos-drill-" + randomBytes(6).toString("hex");
const secrets = join(folder, "secrets"),
  backups = join(folder, "backups");
await mkdir(secrets, { mode: 0o700 });
// Synthetic bind-directory permissions exercise the operator UID. Its private
// parent remains 0700; production directories instead use explicit UID ownership.
await mkdir(backups, { mode: 0o777 });
const { chmod } = await import("node:fs/promises");
await chmod(backups, 0o777);
const composeFile = join(folder, "compose.json");
const appImage = "counter-pos:production-validation",
  opsImage = "counter-pos-operations:production-validation";
const revision = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
const env = {
  ...process.env,
  APP_IMAGE: appImage,
  OPS_IMAGE: opsImage,
  RELEASE_REVISION: revision,
  APP_HOST: "localhost",
  ACME_EMAIL: "synthetic@example.invalid",
  SECRETS_DIRECTORY: secrets,
  BACKUP_DIRECTORY: backups,
};
const checks: string[] = [];
let composeCreated = false,
  stage = "fixture setup";
let result: Record<string, unknown> | undefined;
async function sourceFingerprint() {
  const paths = [
    "infra/Dockerfile",
    "infra/healthcheck.mjs",
    "infra/compose.production.yaml",
    ".dockerignore",
    "scripts/setup.ts",
    "scripts/migrate.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.server.json",
  ];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
      else
        throw new Error(
          "Runtime fingerprint refuses symbolic links or special files",
        );
    }
  }
  for (const folder of [
    "apps",
    "packages",
    "infra/migrations",
    "infra/production",
    "scripts/operations",
  ])
    await visit(folder);
  const hashes: Record<string, string> = {};
  for (const path of paths.sort())
    hashes[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return {
    sha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
    files: hashes,
  };
}
let testedSource: Awaited<ReturnType<typeof sourceFingerprint>> | undefined;
async function docker(args: string[], options: { input?: string } = {}) {
  // execFile never invokes a shell. Secret values are absent from arguments.
  try {
    if (options.input)
      throw new Error(
        "Use private files rather than Docker stdin for this drill",
      );
    return (
      await execute("docker", args, {
        env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180000,
      })
    ).stdout;
  } catch (error) {
    if (process.env.PRODUCTION_DRILL_DEBUG === "1") {
      const diagnostics = String((error as { stderr?: string }).stderr ?? "");
      console.error(
        diagnostics
          .replace(/postgres(?:ql)?:\/\/\S+/g, "[connection withheld]")
          .slice(-8000),
      );
    }
    throw new Error(
      `Production drill failed at ${stage}; inspect the isolated fixture privately`,
    );
  }
}
async function compose(args: string[]) {
  return docker(["compose", "-p", project, "-f", composeFile, ...args]);
}
const port = Number(process.env.PRODUCTION_DRILL_PORT ?? 18443);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = "https://localhost:" + port;
let cookie = "",
  csrf = "";
async function https<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  expected = 200,
  key?: string,
) {
  const headers = join(folder, randomUUID() + ".headers"),
    response = headers + ".body";
  const lines = [
    "url = " + JSON.stringify(origin + path),
    "request = " + JSON.stringify(body === undefined ? "GET" : "POST"),
  ];
  for (const header of [
    "Origin: " + origin,
    "Content-Type: application/json",
    ...(cookie ? ["Cookie: " + cookie] : []),
    ...(csrf ? ["X-CSRF-Token: " + csrf] : []),
    ...(key ? ["Idempotency-Key: " + key] : []),
  ])
    lines.push("header = " + JSON.stringify(header));
  if (body !== undefined)
    lines.push("data = " + JSON.stringify(JSON.stringify(body)));
  const { spawn } = await import("node:child_process");
  const child = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--cacert",
      join(folder, "root.crt"),
      "--dump-header",
      headers,
      "--output",
      response,
      "--write-out",
      "%{http_code}",
      "--max-time",
      "20",
      "--config",
      "-",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(lines.join("\n") + "\n");
  let code = "";
  child.stdout.on("data", (chunk) => {
    code += String(chunk);
  });
  child.stderr.resume();
  await new Promise<void>((ok, fail) => {
    child.once("error", () => fail(new Error("HTTPS probe could not start")));
    child.once("close", (status) =>
      status === 0
        ? ok()
        : fail(new Error("Certificate-validated HTTPS probe failed")),
    );
  });
  assert.equal(Number(code), expected, `HTTPS ${path} status differs`);
  const headerText = await readFile(headers, "utf8"),
    text = await readFile(response, "utf8");
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as T;
  }
  return { body: data, headers: headerText };
}

try {
  const ownerPassword = randomBytes(32).toString("hex"),
    migratorPassword = randomBytes(32).toString("hex"),
    runtimePassword = randomBytes(32).toString("hex"),
    managerPassword = randomBytes(24).toString("hex");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const files: Record<string, string> = {
    "owner-password": ownerPassword,
    "migrator-password": migratorPassword,
    "runtime-password": runtimePassword,
    "permit-secret": randomBytes(48).toString("hex"),
    "runtime-database-url": `postgresql://counter_pos_app:${runtimePassword}@postgres:5432/counter_pos?sslmode=disable`,
    "migrator-database-url": `postgresql://counter_pos_migrator:${migratorPassword}@postgres:5432/counter_pos?sslmode=disable`,
    "restore-admin-url": `postgresql://counter_pos_owner:${ownerPassword}@postgres:5432/postgres?sslmode=disable`,
    "backup-recipient.pem": publicKey,
    "restore-private.pem": privateKey,
    "setup-password": managerPassword,
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(secrets, name), value + "\n", {
      flag: "wx",
      mode: 0o444,
    });
    await chmod(join(secrets, name), 0o444);
  }
  stage = "production compose validation";
  const model = JSON.parse(
    await docker([
      "compose",
      "-f",
      "infra/compose.production.yaml",
      "--profile",
      "operations",
      "config",
      "--format",
      "json",
    ]),
  );
  model.name = project;
  for (const [name, item] of Object.entries(model.volumes) as [
    string,
    { name: string },
  ][])
    item.name = project + "_" + name;
  for (const [name, item] of Object.entries(model.networks) as [
    string,
    { name: string },
  ][])
    item.name = project + "_" + name;
  delete model.services.app.build;
  delete model.services.operations.build;
  model.services.app.environment.APP_ORIGIN = origin;
  model.services.release_check = model.services["release-check"];
  delete model.services["release-check"];
  model.services.release_check.environment.APP_ORIGIN = origin;
  model.services.proxy.ports = [
    {
      mode: "ingress",
      target: 443,
      published: String(port),
      host_ip: "127.0.0.1",
      protocol: "tcp",
    },
  ];
  // localhost uses Caddy's internal CA. No public ACME request or DNS changes occur.
  model.services.operations.volumes.push(
    {
      type: "bind",
      source: join(secrets, "setup-password"),
      target: "/run/secrets/setup_password",
      read_only: true,
    },
    {
      type: "bind",
      source: join(secrets, "restore-admin-url"),
      target: "/run/secrets/restore_admin_url",
      read_only: true,
    },
    {
      type: "bind",
      source: join(secrets, "restore-private.pem"),
      target: "/run/secrets/restore_private_key",
      read_only: true,
    },
  );
  await writeFile(composeFile, JSON.stringify(model), { mode: 0o600 });
  composeCreated = true;
  await compose(["config", "--quiet"]);
  testedSource = await sourceFingerprint();
  checks.push(
    "Production Compose structure and isolated synthetic fixture validated",
  );
  {
    stage = "runtime image build";
    await docker([
      "build",
      "--target",
      "runtime",
      "--build-arg",
      "RELEASE_REVISION=" + revision,
      "-t",
      appImage,
      "-f",
      "infra/Dockerfile",
      repository,
    ]);
    stage = "operator image build";
    await docker([
      "build",
      "--target",
      "operations",
      "--build-arg",
      "RELEASE_REVISION=" + revision,
      "-t",
      opsImage,
      "-f",
      "infra/Dockerfile",
      repository,
    ]);
    checks.push(
      "Both images built from this working snapshot with locked dependency installation",
    );
  }
  stage = "private PostgreSQL initialization";
  await compose(["up", "-d", "--wait", "--wait-timeout", "60", "postgres"]);
  stage = "separate migration credential";
  await compose(["run", "--rm", "operations", "migrate"]);
  stage = "one-time manager bootstrap";
  await compose([
    "run",
    "--rm",
    "-e",
    "SETUP_EMAIL=manager@synthetic.invalid",
    "-e",
    "SETUP_PASSWORD_FILE=/run/secrets/setup_password",
    "-e",
    "SETUP_STORE_NAME=Synthetic Container Drill",
    "operations",
    "setup",
  ]);
  checks.push(
    "Empty PostgreSQL volume initialized with separate owner/migrator/runtime credentials; migrations and one-time manager bootstrap succeeded",
  );
  stage = "restricted runtime release check";
  await compose(["run", "--rm", "release_check"]);
  stage = "serving startup and readiness";
  await compose(["up", "-d", "--wait", "--wait-timeout", "60", "app", "proxy"]);
  const appContainer = (await compose(["ps", "-q", "app"])).trim();
  const proxyContainer = (await compose(["ps", "-q", "proxy"])).trim();
  const inspection = JSON.parse(await docker(["inspect", appContainer]))[0];
  assert.equal(inspection.Config.User, "node");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspection.State.Health.Status, "healthy");
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  const pgPorts = JSON.parse(
    await docker(["inspect", (await compose(["ps", "-q", "postgres"])).trim()]),
  )[0].NetworkSettings.Ports;
  assert.ok(
    Object.values(pgPorts ?? {}).every((binding) => binding === null),
    "Database must not publish a host port",
  );
  stage = "internal HTTPS certificate";
  await docker([
    "cp",
    proxyContainer + ":/data/caddy/pki/authorities/local/root.crt",
    join(folder, "root.crt"),
  ]);
  const live = await https<{ demo: boolean }>("/health/live");
  assert.equal(live.body.demo, false);
  assert.match(live.headers, /strict-transport-security: max-age=31536000/i);
  await https("/health/ready");
  assert.match((await https("/")).headers, /content-security-policy:/i);
  checks.push(
    "Non-root read-only app healthy; private DB unexposed; same-origin local HTTPS validated with CA, HSTS and CSP",
  );
  stage = "production secure login and financial flow";
  const login = await https<{ csrf_token: string }>("/api/v1/auth/login", {
    email: "manager@synthetic.invalid",
    password: managerPassword,
  });
  const setCookie = login.headers
    .split(/\r?\n/)
    .find((line) => /^set-cookie:/i.test(line));
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
  cookie = setCookie
    .slice(setCookie.indexOf(":") + 1)
    .trim()
    .split(";")[0];
  csrf = login.body.csrf_token;
  const category = (
    await https<{ id: string }>(
      "/api/v1/categories",
      { name: "Synthetic" },
      201,
    )
  ).body;
  const productId = (
    await https<{ id: string }>(
      "/api/v1/products",
      {
        name: "Drill item",
        sku: "DRILL-001",
        category_id: category.id,
        unit_price_minor: 500,
        cost_minor: 200,
      },
      201,
    )
  ).body.id;
  await https("/api/v1/inventory/receipts", {
    client_event_id: randomUUID(),
    product_id: productId,
    quantity: 3,
    reason: "Synthetic receipt",
  });
  const product = (await https<{ items: Product[] }>("/api/v1/products")).body
    .items[0];
  const device = (
    await https<{ devices: { id: string }[] }>("/api/v1/bootstrap")
  ).body.devices[0];
  assert.ok(device, "Initial production setup must enroll a selling terminal");
  const shift = (
    await https<{ id: string }>(
      "/api/v1/shifts",
      { device_id: device.id, opening_float_minor: 10000 },
      201,
    )
  ).body;
  const sale: SaleCommand = {
    schema_version: 1,
    client_sale_id: randomUUID(),
    device_id: device.id,
    shift_id: shift.id,
    client_created_at: new Date().toISOString(),
    was_offline: false,
    currency: "SGD",
    lines: [
      {
        line_id: randomUUID(),
        product_id: product.id,
        price_revision_id: product.price_revision_id,
        sku_snapshot: product.sku,
        name_snapshot: product.name,
        quantity: 1,
        unit_price_minor: 500,
        discount_minor: 0,
        tax_bps: 0,
        tax_minor: 0,
        line_total_minor: 500,
      },
    ],
    payment: {
      method: "CASH",
      amount_applied_minor: 500,
      tender_minor: 500,
      change_minor: 0,
    },
    gross_minor: 500,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 500,
  };
  const posted = (
    await https<{ sale_id: string }>(
      "/api/v1/sales",
      sale,
      201,
      sale.client_sale_id,
    )
  ).body;
  assert.equal(
    (
      await https<{ sale_id: string }>(
        "/api/v1/sales",
        sale,
        200,
        sale.client_sale_id,
      )
    ).body.sale_id,
    posted.sale_id,
  );
  const refundId = randomUUID();
  await https(
    "/api/v1/refunds",
    {
      client_refund_id: refundId,
      original_sale_id: posted.sale_id,
      shift_id: shift.id,
      reason: "Synthetic return",
      method: "CASH",
      lines: [
        {
          original_sale_line_id: sale.lines[0].line_id,
          quantity: 1,
          restock: true,
        },
      ],
    },
    201,
    refundId,
  );
  const reconciliation = (
    await https<{ reconciliation_id: string }>(
      `/api/v1/shifts/${shift.id}/reconcile`,
      {
        device_id: device.id,
        sale_ids: [sale.client_sale_id],
        pending_count: 0,
      },
    )
  ).body;
  await https(`/api/v1/shifts/${shift.id}/close`, {
    counted_minor: 10000,
    reconciliation_id: reconciliation.reconciliation_id,
  });
  checks.push(
    "Secure HttpOnly/SameSite login; synthetic receive/cash sale/identical replay/refund/shift reconciliation and close through production HTTPS",
  );
  stage = "retained encrypted backup";
  await compose(["run", "--rm", "operations", "backup"]);
  const archiveName = (await readdir(backups)).find((name) =>
    name.endsWith(".posbackup"),
  );
  assert.ok(archiveName);
  stage = "isolated retained backup restore";
  await compose([
    "run",
    "--rm",
    "-e",
    "BACKUP_FILE=/backups/" + archiveName,
    "-e",
    "RESTORE_PRIVATE_KEY_FILE=/run/secrets/restore_private_key",
    "-e",
    "RESTORE_ADMIN_DATABASE_URL_FILE=/run/secrets/restore_admin_url",
    "-e",
    "RESTORE_DATABASE_NAME=counter_pos_restore_" +
      randomBytes(6).toString("hex"),
    "operations",
    "restore",
  ]);
  const restoreResult = JSON.parse(
    await readFile(join(backups, archiveName + ".restore-result.json"), "utf8"),
  );
  assert.equal(restoreResult.status, "ISOLATED_RESTORE_VERIFIED");
  assert.equal(restoreResult.restored_table_counts.sales, 1);
  assert.equal(restoreResult.restored_table_counts.refunds, 1);
  checks.push(
    "Retained encrypted snapshot backup restored into a newly named database; exact all-table digests and nonzero sale/refund/payment/stock invariants verified",
  );
  stage = "graceful serving shutdown";
  await compose(["stop", "app"]);
  const stopped = JSON.parse(await docker(["inspect", appContainer]))[0];
  assert.equal(stopped.State.ExitCode, 0);
  checks.push(
    "SIGTERM closes serving process cleanly within configured grace period",
  );
  const app = JSON.parse(await docker(["image", "inspect", appImage]))[0],
    ops = JSON.parse(await docker(["image", "inspect", opsImage]))[0];
  result = {
    generated_at: new Date().toISOString(),
    status: "PASS",
    base_commit: revision,
    working_snapshot_uncommitted:
      (await execute("git", ["status", "--porcelain"])).stdout.trim().length >
      0,
    docker_version: (
      await docker(["version", "--format", "{{.Server.Version}}"])
    ).trim(),
    app_image_id: app.Id,
    operations_image_id: ops.Id,
    runtime_source_fingerprint: testedSource.sha256,
    runtime_source_hashes: testedSource.files,
    restored_table_counts: restoreResult.restored_table_counts,
    platform: app.Os + "/" + app.Architecture,
    checks,
    limits: [
      "Synthetic isolated Docker volumes; no live deployment or public ACME issuance",
      "Same-host isolated restore; separate recovery host/off-host transfer/RPO/RTO not measured",
      "Physical terminals/printers/scanners and penetration testing not performed",
      "Image IDs describe the tested local working snapshot; promote exact final-commit registry digests only after release approval",
    ],
    cleanup:
      "Unique fixture containers, networks, volumes, synthetic credentials/private key and retained fixture archives removed after this drill",
  };
} finally {
  try {
    if (composeCreated) {
      stage = "unique fixture cleanup";
      await compose(["down", "--volumes", "--remove-orphans"]);
      const filter = "label=com.docker.compose.project=" + project;
      assert.equal(
        (
          await docker(["ps", "-a", "--filter", filter, "--format", "{{.ID}}"])
        ).trim(),
        "",
        "Fixture containers remain",
      );
      assert.equal(
        (
          await docker([
            "volume",
            "ls",
            "--filter",
            filter,
            "--format",
            "{{.Name}}",
          ])
        ).trim(),
        "",
        "Fixture volumes remain",
      );
      assert.equal(
        (
          await docker([
            "network",
            "ls",
            "--filter",
            filter,
            "--format",
            "{{.ID}}",
          ])
        ).trim(),
        "",
        "Fixture networks remain",
      );
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
if (result) {
  assert.equal(
    (await sourceFingerprint()).sha256,
    testedSource?.sha256,
    "Runtime source changed during the image build/drill; rerun against a frozen snapshot",
  );
  await mkdir("docs/qa", { recursive: true });
  await writeFile(
    "docs/qa/production-operations-results.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    "PASS isolated production containers / HTTPS / secure login / financial flow / retained encrypted restore / graceful shutdown / verified fixture cleanup",
  );
}
