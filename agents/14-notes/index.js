// agents/14-notes/index.js
// On-demand: turn a YouTube video or article URL into structured notes.
// Usage (local):   node agents/14-notes/index.js "https://youtu.be/..."
// Usage (Actions): run the "Video/Article Notes" workflow and paste a URL (14-notes.yml).
import { writeFileSync } from "node:fs";
import { env } from "../../lib/env.js";

const url = process.argv[2] || process.env.NOTE_URL;
if (!url) { console.error("Pass a URL (arg) or set NOTE_URL."); process.exit(1); }
const isYouTube = /youtube\.com|youtu\.be/.test(url);

// For YouTube, Gemini accepts the URL directly as a file part.
// For articles, we fetch + strip and send as text.
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
const notes = data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);

// Email the notes if Resend is configured (works in GitHub Actions).
if (process.env.RESEND_API_KEY) {
  const { notifyEmail } = await import("../../lib/notify.js");
  const safe = notes.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  await notifyEmail(`📝 Notes: ${url}`, `<p><b>${url}</b></p><pre>${safe}</pre>`);
}
// Also save a local file when run on your machine.
try {
  const file = `notes-${Date.now()}.md`;
  writeFileSync(file, `# Notes: ${url}\n\n${notes}\n`);
  console.log(`Saved ${file}`);
} catch {}
console.log(`\n${notes}`);
