// lib/notify.js
import { env } from "./env.js";

// Escape user/LLM content for Telegram HTML parse mode.
export const tgEscape = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Best-effort: mirror every outgoing message into the `agent_outputs` table so the
// dashboard can show a "Responses" feed. Never throws — Telegram/email stay primary.
async function logOutput(channel, title, body) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) return;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(url, key);
    const preview = String(body || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 600);
    const clean = String(title || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    await db.from("agent_outputs").insert({ channel, title: clean, preview, created_at: new Date().toISOString() });
  } catch {}
}

// Telegram — the default for most agents (instant, two-way capable).
// opts.html   -> use HTML parse mode (safer for dynamic text; escape with tgEscape).
// opts.buttons-> array of { text, url } inline buttons (or array-of-arrays for rows).
// opts.preview-> true to allow link previews (default off).
export async function notifyTelegram(text, opts = {}) {
  const body = {
    chat_id: env("TELEGRAM_CHAT_ID"),
    text,
    parse_mode: opts.html ? "HTML" : "Markdown",
    disable_web_page_preview: !opts.preview,
  };
  if (opts.buttons?.length) {
    const rows = Array.isArray(opts.buttons[0]) ? opts.buttons : [opts.buttons];
    body.reply_markup = { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) };
  }
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  await logOutput("telegram", text.split("\n")[0], text);
}

// Email via Resend — for longer digests you want in your inbox.
export async function notifyEmail(subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env("RESEND_FROM"),
      to: env("MY_EMAIL"),
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  await logOutput("email", subject, html);
}
