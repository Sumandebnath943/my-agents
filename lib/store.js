// lib/store.js
import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

export async function getState(key, fallback = null) {
  const { data, error } = await db.from("kv").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? data.value : fallback;
}

export async function setState(key, value) {
  const { error } = await db
    .from("kv")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}
