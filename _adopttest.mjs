import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env={};
for (const l of readFileSync("D:/project/agents-for-suman/.env","utf8").split(/\r?\n/)) {
  const i=l.indexOf("="); const k=i>0?l.slice(0,i):null;
  if(k && /^[A-Z_0-9]+$/.test(k) && !env[k]) env[k]=l.slice(i+1).trim();
}
const db=createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
// Plant an unconfirmed dispatcher claim exactly as the dispatcher would write it, for the slot
// Supabase Keep-Alive is genuinely due at today (cron "11 9 * * *").
const KEY = `gate:Supabase Keep-Alive:11 9 * * *:${new Date().toISOString().slice(0,11)}09:11Z`;
await db.from("kv").delete().eq("key", KEY);
await db.from("kv").insert({ key: KEY, value: { by:"dispatcher", at:new Date().toISOString(), run_id:null }, updated_at:new Date().toISOString() });
const before=(await db.from("kv").select("value").eq("key",KEY).maybeSingle()).data?.value;
console.log("planted   :", KEY);
console.log("           ", JSON.stringify(before));
console.log("\nnow dispatch the agent, then re-check...");
