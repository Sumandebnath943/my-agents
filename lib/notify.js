// lib/notify.js
import { env } from "./env.js";

// Telegram — the default for most agents (instant, two-way capable).
export async function notifyTelegram(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env("TELEGRAM_CHAT_ID"),
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    }
  );
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
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
}
