import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const cost = 32768;
const derive = (password: string, salt: string, n: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, cost);
  return `scrypt$${cost}$8$1$${salt}$${key.toString("hex")}`;
}

// Existing setup/seed hashes remain usable; new credentials use explicit KDF parameters.
export async function passwordMatches(
  password: string,
  stored: string,
): Promise<boolean> {
  let salt: string, expected: string, n: number;
  if (/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) {
    [salt, expected] = stored.split(":");
    n = 16384;
  } else {
    const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(
      stored,
    );
    if (!match) return false;
    [, salt, expected] = match;
    n = cost;
  }
  const actual = await derive(password, salt, n);
  return timingSafeEqual(Buffer.from(expected, "hex"), actual);
}

export const dummyPasswordHash = `scrypt$32768$8$1$${"0".repeat(32)}$${"0".repeat(128)}`;
