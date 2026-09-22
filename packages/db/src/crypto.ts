import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// AES-256-GCM at-rest encryption for integration tokens (GitHub PATs, Slack
// bot tokens). Real encryption, not obfuscation: a random 12-byte IV per
// call, the GCM auth tag stored alongside the ciphertext so tampering is
// detectable, both fed from a 32-byte key the deployer controls via
// INTEGRATION_ENCRYPTION_KEY -- never hardcoded here.

function getKey(): Buffer {
  const b64 = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(encrypted: string): string {
  const key = getKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("malformed encrypted token");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// Session tokens (services/chat-server/src/auth.ts) are handled
// differently from the integration tokens above: there's nothing to
// decrypt back -- the raw token only ever needs to be *recognized* again
// (does this cookie match a live session?), never read back out. A
// one-way SHA-256 hash is the standard shape for that (same reason a
// password or API key gets hashed, not encrypted): even a full read of
// the `sessions` table's `token_hash` column can't be turned back into a
// working session cookie. No secret key involved -- the token itself
// (32 random bytes, generated in auth.ts) is already the only thing that
// needs to stay secret, and it never touches disk in this form.
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
