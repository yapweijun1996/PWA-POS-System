import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("COUNTER-POS-BACKUP-V1\n");
const tagSize = 16;
export type TableDigest = { rows: number; sha256: string };
export type BackupManifest = {
  tables: Record<string, TableDigest>;
  migrations: string[];
};
export type BackupHeader = {
  version: 1;
  algorithm: "RSA-OAEP-SHA256/AES-256-GCM";
  backup_id: string;
  created_at: string;
  release_revision: string;
  database_name: string;
  recipient_sha256: string;
  wrapped_key: string;
  iv: string;
  manifest: BackupManifest;
};

export function recipientFingerprint(publicPem: string | Buffer) {
  const key = createPublicKey(publicPem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new Error(
      "Backup recipient must be an RSA public key of at least 3072 bits",
    );
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function encryptBackup(
  plaintext: Readable,
  output: string,
  publicPem: string | Buffer,
  metadata: Omit<
    BackupHeader,
    "version" | "algorithm" | "recipient_sha256" | "wrapped_key" | "iv"
  >,
) {
  const fingerprint = recipientFingerprint(publicPem);
  const key = randomBytes(32),
    iv = randomBytes(12);
  const wrapped = publicEncrypt(
    {
      key: publicPem,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    key,
  );
  const header: BackupHeader = {
    version: 1,
    algorithm: "RSA-OAEP-SHA256/AES-256-GCM",
    ...metadata,
    recipient_sha256: fingerprint,
    wrapped_key: wrapped.toString("base64"),
    iv: iv.toString("base64"),
  };
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > 1024 * 1024)
    throw new Error("Backup manifest is too large");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const prefix = Buffer.concat([magic, length, json]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(prefix);
  const file = await open(output, "wx", 0o600);
  try {
    await file.write(prefix);
    await file.close();
    await pipeline(
      plaintext,
      cipher,
      createWriteStream(output, { flags: "a" }),
    );
    const tail = await open(output, "a");
    try {
      await tail.write(cipher.getAuthTag());
      await tail.sync();
    } finally {
      await tail.close();
    }
    return header;
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  } finally {
    key.fill(0);
    await file.close().catch(() => {});
  }
}

export async function decryptBackup(
  input: string,
  output: string,
  privatePem: Buffer | string | KeyObject,
) {
  const file = await open(input, "r");
  let created = false;
  try {
    const initial = Buffer.alloc(magic.length + 4);
    const first = await file.read(initial, 0, initial.length, 0);
    if (
      first.bytesRead !== initial.length ||
      !initial.subarray(0, magic.length).equals(magic)
    )
      throw new Error("Unsupported or truncated encrypted backup");
    const size = initial.readUInt32BE(magic.length);
    const total = (await file.stat()).size;
    if (
      size === 0 ||
      size > 1024 * 1024 ||
      total <= initial.length + size + tagSize
    )
      throw new Error("Invalid encrypted backup size");
    const json = Buffer.alloc(size);
    if ((await file.read(json, 0, size, initial.length)).bytesRead !== size)
      throw new Error("Truncated encrypted header");
    const header = JSON.parse(json.toString("utf8")) as BackupHeader;
    if (
      header.version !== 1 ||
      header.algorithm !== "RSA-OAEP-SHA256/AES-256-GCM" ||
      !header.manifest?.tables ||
      !Array.isArray(header.manifest.migrations)
    )
      throw new Error("Unsupported encrypted backup header");
    const iv = Buffer.from(header.iv, "base64");
    if (iv.length !== 12) throw new Error("Invalid encrypted backup IV");
    const tag = Buffer.alloc(tagSize);
    await file.read(tag, 0, tagSize, total - tagSize);
    const key = privateDecrypt(
      {
        key: privatePem,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(header.wrapped_key, "base64"),
    );
    if (key.length !== 32) throw new Error("Invalid recovered backup key");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.concat([initial, json]));
    decipher.setAuthTag(tag);
    const destination = await open(output, "wx", 0o600);
    created = true;
    try {
      await destination.close();
      await pipeline(
        createReadStream(input, {
          start: initial.length + size,
          end: total - tagSize - 1,
        }),
        decipher,
        createWriteStream(output, { flags: "r+" }),
      );
      const committed = await open(output, "r+");
      try {
        await committed.sync();
      } finally {
        await committed.close();
      }
    } finally {
      key.fill(0);
      await destination.close().catch(() => {});
    }
    if (((await stat(output)).mode & 0o777) !== 0o600)
      throw new Error("Recovered archive permissions are unsafe");
    return header;
  } catch (error) {
    if (created) await unlink(output).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}
