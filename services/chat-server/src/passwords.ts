import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's 32 MiB scrypt configuration. Run asynchronously off the event loop.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split("$");
  const valid = parts?.length === 6 && parts.slice(0, 4).join("$") === "scrypt$32768$8$3" && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
  // Missing users still pay the same password-hashing cost.
  const actual = await derive(password, valid ? Buffer.from(parts![4], "hex") : Buffer.alloc(16));
  const expected = valid ? Buffer.from(parts![5], "hex") : Buffer.alloc(64);
  return timingSafeEqual(actual, expected) && !!valid;
}
