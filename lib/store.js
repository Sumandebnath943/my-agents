// lib/store.js
import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Lazy client so importing this module needs no Supabase env until a call is made.
let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

// --- Transient retry ---------------------------------------------------------------------
// Supabase/PostgREST calls can fail on a flaky network or a brief 5xx. Those are transient —
// a short backoff usually recovers. Mirrors the retry idiom in lib/llm.js. PERMANENT errors
// (missing table, RLS, bad SQL) are NOT retried — they surface immediately so bugs aren't hidden.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 3;
const backoff = (attempt) => Math.min(300 * 2 ** attempt, 3000) + Math.floor(Math.random() * 200);

function isTransient(e) {
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return /fetch failed|network|timeout|econn|socket|und_err|terminated|429|502|503|504|temporarily|unavailable/.test(s);
}

async function withRetry(fn) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1 && isTransient(e)) { await sleep(backoff(attempt)); continue; }
      throw e;
    }
  }
}

export async function getState(key, fallback = null) {
  return withRetry(async () => {
    const { data, error } = await db().from("kv").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? data.value : fallback;
  });
}

export async function setState(key, value) {
  return withRetry(async () => {
    const { error } = await db()
      .from("kv")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  });
}
