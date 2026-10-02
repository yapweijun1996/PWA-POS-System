import { afterAll, describe, expect, it } from "vitest";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  decryptBackup,
  encryptBackup,
  fileSha256,
  recipientFingerprint,
} from "../../scripts/operations/envelope.ts";
import {
  postgresEnvironment,
  restoreName,
} from "../../scripts/operations/postgres.ts";

const folder = await mkdtemp(join(tmpdir(), "counter-pos-envelope-test-"));
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const metadata = {
  backup_id: randomUUID(),
  created_at: "2026-10-03T00:00:00.000Z",
  release_revision: "test",
  database_name: "synthetic",
  manifest: { tables: {}, migrations: [] },
};
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("Retained encrypted operational backups", () => {
  it("streams authenticated bytes with restrictive modes, no plaintext retained by encryption", async () => {
    const input = Buffer.alloc(2 * 1024 * 1024, 83);
    const encrypted = join(folder, "roundtrip.backup"),
      recovered = join(folder, "recovered.dump");
    await encryptBackup(
      Readable.from([input.subarray(0, 12345), input.subarray(12345)]),
      encrypted,
      publicKey,
      metadata,
    );
    expect((await stat(encrypted)).mode & 0o777).toBe(0o600);
    expect(await fileSha256(encrypted)).toMatch(/^[a-f0-9]{64}$/);
    const result = await decryptBackup(encrypted, recovered, privateKey);
    expect(result.recipient_sha256).toBe(recipientFingerprint(publicKey));
    expect(result.manifest).toEqual(metadata.manifest);
    expect((await readFile(recovered)).equals(input)).toBe(true);
    expect((await stat(recovered)).mode & 0o777).toBe(0o600);
  });
  it("rejects ciphertext/header tampering and removes unauthenticated plaintext", async () => {
    const encrypted = join(folder, "tampered.backup"),
      recovered = join(folder, "tampered.dump");
    await encryptBackup(
      Readable.from([Buffer.from("synthetic pg archive")]),
      encrypted,
      publicKey,
      metadata,
    );
    const bytes = await readFile(encrypted);
    bytes[bytes.length - 17] ^= 1;
    await writeFile(encrypted, bytes);
    await expect(
      decryptBackup(encrypted, recovered, privateKey),
    ).rejects.toThrow();
    await expect(stat(recovered)).rejects.toThrow();
    const clean = join(folder, "header.backup");
    await encryptBackup(
      Readable.from([Buffer.from("synthetic archive")]),
      clean,
      publicKey,
      metadata,
    );
    const altered = (await readFile(clean))
      .toString("latin1")
      .replace("synthetic", "wrongdata");
    await writeFile(clean, altered, "latin1");
    await expect(decryptBackup(clean, recovered, privateKey)).rejects.toThrow();
    await expect(stat(recovered)).rejects.toThrow();
  });
  it("refuses key substitution, short RSA keys and existing output", async () => {
    const file = join(folder, "wrong-key.backup"),
      recovered = join(folder, "wrong-key.dump");
    await encryptBackup(
      Readable.from([Buffer.from("archive")]),
      file,
      publicKey,
      metadata,
    );
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    expect(() => recipientFingerprint(other.publicKey)).toThrow();
    await expect(
      decryptBackup(file, recovered, other.privateKey),
    ).rejects.toThrow();
    await expect(
      encryptBackup(
        Readable.from([Buffer.from("new")]),
        file,
        publicKey,
        metadata,
      ),
    ).rejects.toThrow();
  });
  it("supports a separately protected PEM recovery key", async () => {
    const file = join(folder, "protected-key.backup"),
      recovered = join(folder, "protected-key.dump");
    await encryptBackup(
      Readable.from([Buffer.from("protected recovery")]),
      file,
      publicKey,
      metadata,
    );
    const protectedPem = createPrivateKey(privateKey).export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "synthetic recovery passphrase",
    });
    const parsed = createPrivateKey({
      key: protectedPem,
      format: "pem",
      passphrase: "synthetic recovery passphrase",
    });
    await decryptBackup(file, recovered, parsed);
    expect((await readFile(recovered)).toString()).toBe("protected recovery");
  });
  it("never accepts a live or invalid restore database name", () => {
    expect(restoreName("counter_pos_restore_drill_20261003")).toBe(
      "counter_pos_restore_drill_20261003",
    );
    for (const name of [
      "counter_pos",
      "counter_pos_dev",
      "postgres",
      "counter_pos_restore_x;DROP DATABASE a",
      "counter_pos_restore_",
    ])
      expect(() => restoreName(name)).toThrow();
  });
  it("passes database credentials only through child environment and respects TLS options", () => {
    const env = postgresEnvironment(
      "postgresql://operator:synthetic%40password@db:5432/test?sslmode=verify-full",
    );
    expect(env.PGPASSWORD).toBe("synthetic@password");
    expect(env.PGSSLMODE).toBe("verify-full");
    expect(() =>
      postgresEnvironment("postgresql://operator@db/test?unknown=1"),
    ).toThrow();
  });
});
