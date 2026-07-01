// agents/15-journal/handle.js
// Handler for the inbox router: turn a freeform reply into a structured journal entry.
// Uses Groq (private — Gemini's free tier may train on inputs; reflections stay on Groq).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

export async function handleJournal(msg) {
  if (!msg.text || msg.text.length < 10) return false; // skip stray short messages
  const out = await callGroq(
    [
      { role: "system", content: 'Turn a journal brain-dump into JSON {"mood":"one or two words","themes":["..."],"summary":"2-sentence reflective summary"}. Be warm, never judgmental.' },
      { role: "user", content: msg.text },
    ],
    { json: true } // Groq keeps this private
  );
  const { mood, themes, summary } = parseJson(out);
  await db.from("journal").insert({
    entry_date: new Date().toISOString().slice(0, 10),
    raw: msg.text, mood, themes, summary,
  });
  await notifyTelegram(`🌙 <b>Reflection saved</b>\nmood: ${tgEscape(mood)}`, { html: true });
  return true;
}
