// agents/13-readlater/handle.js
// Handler for the inbox router: given a Telegram message containing link(s),
// fetch + summarize each and save to the `reading` table. Returns count saved.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { scrapeClean } from "../../lib/scrape.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const URL_RE = /https?:\/\/[^\s]+/g;

export async function handleReadLater(msg) {
  const urls = msg.text.match(URL_RE) || [];
  let saved = 0;
  for (const url of urls) {
    // Clean article text — Firecrawl when available (better on JS/paywalled pages), else fetch+strip.
    const text = await scrapeClean(url, { max: 8000 });

    const out = await callLLM(
      `Summarize this article for my reading queue. Return ONLY JSON:
{"title":"...","summary":"3-4 sentence summary","tags":["..."]}.
URL: ${url}\nContent: ${text || "(could not fetch; infer from URL)"}`,
      { json: true, chain: "public" } // runs under the webhook (AGENT_NAME=migi) → force the public chain
    );
    const { title, summary, tags } = parseJson(out);
    await db.from("reading").insert({ url, title, summary, tags });
    const tagLine = (tags || []).length ? `\n🏷️ ${tgEscape((tags || []).join(" · "))}` : "";
    await notifyTelegram(
      `📚 <b>Saved to your reading queue</b>\n${tgEscape(title)}${tagLine}`,
      { html: true, buttons: [{ text: "📖 Open article", url }] }
    );
    saved++;
  }
  return saved;
}
