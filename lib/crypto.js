// lib/crypto.js — optional envelope encryption for secrets stored at rest (currently the LinkedIn
// OAuth token in the kv table). AES-256-GCM. MUST stay byte-compatible with the dashboard's copy
// (agents-dashboard/lib/crypto.js) since both read/write the same kv row.
//
// DORMANT until TOKEN_ENC_KEY is set. With no key: sealValue returns the value UNCHANGED (plaintext,
// exactly as before) and openValue passes plaintext through — so deploying this changes nothing until
// you configure the key. To activate, set TOKEN_ENC_KEY (32 bytes, base64 or hex) in BOTH environments
// that touch the token: the agent fleet (GitHub Actions secrets) AND the dashboard (Vercel). Legacy
// plaintext rows are read transparently and re-sealed on the next write. Do NOT remove the key once set.
import crypto from "node:crypto";

const PREFIX = "gcm:v1:";

function key() {
  const raw = process.env.TOKEN_ENC_KEY || "";
  if (!raw) return null;
  try { const b = Buffer.from(raw, "base64"); if (b.length === 32) return b; } catch {}
  try { const b = Buffer.from(raw, "hex"); if (b.length === 32) return b; } catch {}
  return null;
}

// Encrypt a JSON-serializable value for storage. No key configured -> returned unchanged.
export function sealValue(value) {
  const k = key();
  if (!k) return value;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return { enc: PREFIX + Buffer.concat([iv, tag, enc]).toString("base64") };
}

// Decrypt a stored value. Legacy plaintext (no envelope) is returned as-is.
export function openValue(stored) {
  if (!stored || typeof stored !== "object" || typeof stored.enc !== "string" || !stored.enc.startsWith(PREFIX)) {
    return stored;
  }
  const k = key();
  if (!k) throw new Error("TOKEN_ENC_KEY is required to read an encrypted value");
  const raw = Buffer.from(stored.enc.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8"));
}
