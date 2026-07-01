// agents/13-readlater/handle.js
// Handler for the inbox router: given a Telegram message containing link(s),
// fetch + summarize each and save to the `reading` table. Returns count saved.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const URL_RE = /https?:\/\/[^\s]+/g;

export async function handleReadLater(msg) {
  const urls = msg.text.match(URL_RE) || [];
  let saved = 0;
  for (const url of urls) {
    // Fetch the page and strip tags to rough text (good enough for summarizing).
    let text = "";
    try {
      const html = await fetch(url).then((r) => r.text());
      text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                 .replace(/<style[\s\S]*?<\/style>/gi, "")
                 .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
    } catch { text = ""; }

    const out = await callGemini(
      `Summarize this article for my reading queue. Return ONLY JSON:
{"title":"...","summary":"3-4 sentence summary","tags":["..."]}.
URL: ${url}\nContent: ${text || "(could not fetch; infer from URL)"}`,
      { json: true }
    );
    const { title, summary, tags } = parseJson(out);
    await db.from("reading").insert({ url, title, summary, tags });
    saved++;
  }
  if (saved) await notifyTelegram(`📚 Saved *${saved}* link(s) to your reading queue.`);
  return saved;
}
