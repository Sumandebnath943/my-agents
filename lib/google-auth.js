// lib/google-auth.js
// Service-account -> short-lived OAuth access token (JWT-bearer grant). Used by the
// Brand Manager for Search Console + GA4 Data API. GOOGLE_SA_JSON is the minified
// service-account JSON (a credential — Secrets only, never committed).
import { env } from "./env.js";
import { createSign } from "node:crypto";

export async function googleToken(scope) {
  const sa = JSON.parse(env("GOOGLE_SA_JSON"));
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const c = Buffer.from(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })).toString("base64url");
  const s = createSign("RSA-SHA256"); s.update(`${h}.${c}`);
  const jwt = `${h}.${c}.${s.sign(sa.private_key, "base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  }).then((x) => x.json());
  return r.access_token;
}
