// lib/notify.js
import { env } from "./env.js";
import { logEvent } from "./ops.js";

// MAS context: when a run is started BY the Multi-Agent System (MAS_RUN=1), all user-facing
// delivery is redirected to the SEPARATE MAS bot ONLY and the normal channels are suppressed
// — so a MAS-triggered run of an existing agent never posts into that agent's usual Telegram
// or email. DORMANT in every scheduled run (MAS_RUN unset) → default behavior is byte-for-byte
// unchanged. (Domain DB writes are a per-agent concern and intentionally not intercepted here.)
const masRun = () => process.env.MAS_RUN === "1" && process.env.MAS_BOT_TOKEN && process.env.MAS_CHAT_ID;
async function sendToMas(text) {
  await fetch(`https://api.telegram.org/bot${process.env.MAS_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.MAS_CHAT_ID, text: `[MAS] ${String(text)}`.slice(0, 4096), disable_web_page_preview: true }),
  }).catch(() => {});
}

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

// ---------------------------------------------------------------------------------
// Push to the Migi Android app, via an ntfy topic.
//
// Best-effort, exactly like logOutput() above: returns early when unconfigured, never
// throws, and runs only after Telegram/email have already been delivered. Placed
// alongside logOutput() so it inherits that call site's position — after the masRun()
// early-return — which means a MAS-triggered run never pushes.
//
// Set NTFY_TOPIC to a long random string and subscribe the phone to it. Unset it and
// this file behaves exactly as it did before: every call returns on the first line.
// ---------------------------------------------------------------------------------

// HTTP headers must be latin-1; agent messages are full of emoji, which would throw
// on fetch. Strip to ASCII for the header and leave the body untouched.
const asciiHeader = (s, max) =>
  String(s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || "MIGI";

/**
 * Three tiers, decided centrally so no agent needs to know it is being pushed.
 *   5 — the fleet is broken: a failure, a site down, a paused project, a spent quota.
 *   4 — something is waiting on you: a draft, a prepared application, an approval.
 *   1 — routine traffic (uptime all-clear, digests, check-ins): delivered silently.
 *   3 — everything else.
 * Failure wins over routine, so an uptime run that reports a site down still shouts.
 */
function pushTier(text) {
  const t = text.toLowerCase();
  if (/(fail|error|down|paused|exhausted|rate.?limit|blocked|expired)/.test(t)) {
    return { priority: 5, tags: "rotating_light" };
  }
  if (/(awaiting|approve|approval|draft|prepared|ready to send|needs you|review)/.test(t)) {
    return { priority: 4, tags: "inbox_tray" };
  }
  if (/(uptime|keep-alive|keepalive|all clear|digest|standup|briefing|read later|video|check-in)/.test(t)) {
    return { priority: 1, tags: "newspaper" };
  }
  return { priority: 3, tags: "robot" };
}

async function pushNotify(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const clean = String(body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const { priority, tags } = pushTier(`${title} ${clean}`);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: asciiHeader(title, 120),
        Priority: String(priority),
        Tags: tags,
      },
      body: clean.slice(0, 1000),
      // Never hold an agent up waiting on a notification broker.
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

// Telegram — the default for most agents (instant, two-way capable).
// opts.html   -> use HTML parse mode (safer for dynamic text; escape with tgEscape).
// opts.buttons-> array of { text, url } inline buttons (or array-of-arrays for rows).
// opts.preview-> true to allow link previews (default off).
export async function notifyTelegram(text, opts = {}) {
  if (masRun()) return sendToMas(text);
  const body = {
    chat_id: env("TELEGRAM_CHAT_ID"),
    text,
    parse_mode: opts.html ? "HTML" : "Markdown",
    disable_web_page_preview: !opts.preview,
  };
  if (opts.buttons?.length) {
    const rows = Array.isArray(opts.buttons[0]) ? opts.buttons : [opts.buttons];
    body.reply_markup = {
      inline_keyboard: rows.map((row) => row.map((b) => ({
        text: b.text,
        ...(b.url ? { url: b.url } : {}),
        ...(b.callback_data ? { callback_data: b.callback_data } : {}),
      }))),
    };
  }
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  await logOutput("telegram", text.split("\n")[0], text);
  await pushNotify(text.split("\n")[0], text);
}

// Telegram document — send a file (PDF/DOCX/etc.) to your chat via sendDocument.
// buffer = Node Buffer/Uint8Array, filename sets the shown name + type. Best-effort caption.
export async function notifyTelegramDocument(buffer, filename, caption = "") {
  if (masRun()) return sendToMas(`📄 ${filename}${caption ? " — " + caption : ""}`);
  const form = new FormData();
  form.append("chat_id", env("TELEGRAM_CHAT_ID"));
  if (caption) { form.append("caption", caption.slice(0, 1024)); form.append("parse_mode", "HTML"); }
  form.append("document", new Blob([buffer]), filename);
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendDocument`,
    { method: "POST", body: form }
  );
  if (!res.ok) throw new Error(`Telegram sendDocument ${res.status}: ${await res.text()}`);
  await logOutput("telegram", filename, caption || filename);
  await pushNotify(filename, caption || filename);
}

// Email via Resend — for longer digests you want in your inbox.
export async function notifyEmail(subject, html) {
  if (masRun()) return sendToMas(`✉️ ${subject}`);
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
  if (!res.ok) {
    const detail = `Resend ${res.status}: ${await res.text()}`;
    await logEvent({ kind: "email_fail", ok: false, detail: `${subject} — ${detail}` });
    throw new Error(detail);
  }
  await logOutput("email", subject, html);
  await pushNotify(subject, html);
}
