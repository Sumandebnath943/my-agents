// agents/13-readlater/digest.js — weekly resurfacing of unread saves (email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const { data } = await db.from("reading").select("*").eq("read", false).order("created_at");
if (!data?.length) process.exit(0);

const html = data
  .map((r) => `<p><a href="${r.url}">${r.title}</a> — ${r.summary} <i>[${(r.tags || []).join(", ")}]</i></p>`)
  .join("");
await notifyEmail(`📖 ${data.length} unread saves this week`, html);
