// agents/mas/blackboard.js — MAS mission state access from the slow plane (GitHub Actions).
// Reads/writes ONLY the MAS-owned tables. Lazy client (import needs no env until first call).
import { createClient } from "@supabase/supabase-js";

let _db;
const db = () => (_db ||= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));

export async function getMission(id) {
  const { data } = await db().from("mas_missions").select("*").eq("id", id).maybeSingle();
  return data;
}
export async function updateMission(id, patch) {
  await db().from("mas_missions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}
export async function addMessage(m) {
  await db().from("mas_messages").insert(m).then(() => {}, () => {});
}
