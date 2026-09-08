// lib/notify.js
import { env } from "./env.js";
import { logEvent } from "./ops.js";
import { createHash } from "node:crypto";

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

// Topic resolution. NTFY_TOPIC wins wherever a workflow maps it; otherwise the topic is
// derived from SUPABASE_KEY, which 42 of the 46 workflows already map for logOutput().
// That avoids adding a line to every workflow file, and it is safe in a public repo: what
// is stored here is a hash of a secret, never the secret. Rotating the Supabase key
// changes the topic, which ends push until the app is given the new one.
let cachedTopic = null;
function ntfyTopic() {
  if (cachedTopic !== null) return cachedTopic;
  if (process.env.NTFY_TOPIC) return (cachedTopic = process.env.NTFY_TOPIC);
  const key = process.env.SUPABASE_KEY;
  cachedTopic = key
    ? "migi-" + createHash("sha256").update(key).digest("hex").slice(0, 24)
    : "";
  return cachedTopic;
}

async function pushNotify(title, body) {
  const topic = ntfyTopic();
  if (!topic) return;
  try {
    // Agents send Telegram HTML, so tags have to come out of BOTH parts — the title was
    // arriving as literal "<b>Uptime: 1 issue(s)</b>" on the phone.
    const stripHtml = (s) => String(s ?? "").replace(/<[^>]+>/g, "");

    // Collapse spaces but keep newlines: these messages are lists, and flattening every
    // whitespace run turned a readable site-by-site report into one long paragraph.
    // The first line is dropped because it is already the notification's title.
    const clean = stripHtml(body)
      .split("\n")
      .slice(1)
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const { priority, tags } = pushTier(`${title} ${clean}`);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: asciiHeader(stripHtml(title), 120),
        Priority: String(priority),
        Tags: tags,
      },
      body: clean.slice(0, 1000),
      // Never hold an agent up waiting on a notification broker.
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// One send path for every Telegram method, with a retry that honours the server's hint.
//
// ⚠️ A 429 HERE DESTROYS CONTENT — that is why it is retried rather than thrown on.
//
// On 8 Sep 2026 a LinkedIn draft was written, critiqued, safety-reviewed and inserted, and
// then the approval message hit `429 … retry_after: 373` from a burst of manual runs. The
// throw killed the rest of sendDraft, so the carousel, the card and the verbatim check never
// ran and the draft was stranded in `awaiting` with no way to approve it. LinkedIn got off
// lightly: it writes its row BEFORE notifying. Most agents don't — logOutput() below runs
// only AFTER a successful send, so for briefing/standup/uptime/digests a 429 means the
// generated output is gone entirely, tokens spent, with no copy anywhere.
//
// Telegram states the wait in the rejection itself (`parameters.retry_after`, SECONDS). The
// old code read that field only to paste it into an error message. Waiting is nearly free
// here — jobs are 10-30 min and the runner is billed at zero on a public repo — so the
// default ceiling is deliberately generous enough to cover a real flood-wait.
//
// The ceiling exists for the ONE caller where blocking is not free: mcp/server.js sends on an
// interactive tool call and passes a short maxWaitMs, because a client hanging for six minutes
// is worse than a failed send it can retry by hand.
// ---------------------------------------------------------------------------------
const TG_ATTEMPTS = 3;
const tgWaitCeiling = (opts) =>
  Number(opts.maxWaitMs ?? process.env.TELEGRAM_RETRY_MAX_MS ?? 420_000);

// Telegram's own hint, in seconds; +1s so we come back just after the window, not on its edge.
function tgRetryMs(body) {
  try {
    const s = Number(JSON.parse(body)?.parameters?.retry_after);
    return Number.isFinite(s) && s > 0 ? s * 1000 + 1000 : null;
  } catch { return null; }
}

/**
 * POST to a Telegram method, retrying only what retrying can fix. Returns the ok response.
 * `label` keeps each caller's existing error text intact ("Telegram 429: …",
 * "Telegram sendDocument 429: …") so anything matching on those strings still matches.
 */
async function tgSend(method, init, label, opts = {}) {
  const url = `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${method}`;
  const ceiling = tgWaitCeiling(opts);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    const err = new Error(`${label} ${res.status}: ${body}`);
    // 4xx other than 429 is us, not them: a bad chat id or unparseable HTML fails identically
    // however many times it is sent. Fail fast rather than sleeping toward the same wall.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= TG_ATTEMPTS - 1) throw err;
    const wait = res.status === 429
      ? (tgRetryMs(body) ?? 5_000 * (attempt + 1))
      : 2_000 * (attempt + 1);
    // Sleeping past the ceiling only to fail anyway wastes the wall clock the job has left.
    if (wait > ceiling) throw new Error(`${err.message} (retry_after exceeds the ${Math.round(ceiling / 1000)}s ceiling — not waiting)`);
    console.error(`${label}: ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

// Telegram — the default for most agents (instant, two-way capable).
// opts.html   -> use HTML parse mode (safer for dynamic text; escape with tgEscape).
// opts.buttons-> array of { text, url } inline buttons (or array-of-arrays for rows).
// opts.preview-> true to allow link previews (default off).
// opts.maxWaitMs -> cap a flood-wait retry (default 7 min; see tgSend).
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
  await tgSend(
    "sendMessage",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Telegram",
    opts
  );
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
  // A FormData body is re-serialized per fetch (Blob.stream() hands out a fresh stream), so the
  // same init is safe to hand to a retry — unlike a raw stream body, which would be consumed.
  await tgSend("sendDocument", { method: "POST", body: form }, "Telegram sendDocument");
  await logOutput("telegram", filename, caption || filename);
  await pushNotify(filename, caption || filename);
}

// Telegram photo — send an image INLINE (sendPhoto) rather than as a file attachment, so it is
// visible in the chat without a download. Used to show the LinkedIn insight card at approval time:
// you should see the picture before you approve the post that carries it.
// Optional `buttons` so the photo can carry the approve/edit controls itself.
export async function notifyTelegramPhoto(buffer, caption = "", opts = {}) {
  if (masRun()) return sendToMas(`🖼️ ${caption || "image"}`);
  const form = new FormData();
  form.append("chat_id", env("TELEGRAM_CHAT_ID"));
  if (caption) { form.append("caption", caption.slice(0, 1024)); form.append("parse_mode", "HTML"); }
  if (opts.buttons?.length) {
    const rows = Array.isArray(opts.buttons[0]) ? opts.buttons : [opts.buttons];
    form.append("reply_markup", JSON.stringify({ inline_keyboard: rows }));
  }
  form.append("photo", new Blob([buffer], { type: "image/png" }), opts.filename || "card.png");
  await tgSend("sendPhoto", { method: "POST", body: form }, "Telegram sendPhoto", opts);
  await logOutput("telegram", "photo", caption || "image");
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
