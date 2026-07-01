// agents/14-notes/generate.js
// Reusable: turn a YouTube/article URL into structured notes (used by the CLI
// workflow AND the /notes Telegram command).
import { env } from "../../lib/env.js";

export async function generateNotes(url) {
  const isYouTube = /youtube\.com|youtu\.be/.test(url);
  const parts = [{ text: "Produce structured notes from this: a 2-line TL;DR, key points as bullets, any numbers/quotes worth keeping, and 'action items for me' if relevant. Be faithful, don't pad." }];

  if (isYouTube) {
    parts.push({ file_data: { file_uri: url } });
  } else {
    const html = await fetch(url).then((r) => r.text());
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 12000);
    parts.push({ text: `Article (${url}):\n${text}` });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env("GEMINI_API_KEY")}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) }
  );
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
}
