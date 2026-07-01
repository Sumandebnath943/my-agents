// agents/13-readlater/digest.js — weekly resurfacing of unread saves (designed email).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const { data } = await db.from("reading").select("*").eq("read", false).order("created_at");
if (!data?.length) process.exit(0);

const items = data.map((r) => ({
  title: r.title || r.url,
  note: `${r.summary || ""}${(r.tags || []).length ? `  [${(r.tags || []).join(", ")}]` : ""}`.trim(),
  link: r.url,
  buttonLabel: "Open",
}));

const html = renderEmail({
  title: "📖 Your Reading Queue",
  kicker: `${data.length} UNREAD SAVES`,
  accent: "#D4537E",
  blocks: [{ type: "listSection", ramp: "pink", heading: "🔖 SAVED FOR LATER", items }],
  footer: "Send any link to your bot to add to this queue",
});
await notifyEmail(`📖 ${data.length} unread saves this week`, html);
console.log("readlater digest sent:", data.length);
