// lib/env.js
// Locally, reads .env into process.env. In GitHub Actions, vars are already set,
// so this safely does nothing if .env is absent.
import { readFileSync, existsSync } from "node:fs";

const path = new URL("../.env", import.meta.url);
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

export const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
};
