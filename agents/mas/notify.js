// agents/mas/notify.js — deliver MAS slow-plane output to the SEPARATE MAS Telegram bot
// ONLY (MAS_BOT_TOKEN / MAS_CHAT_ID). Never touches the main bot or email — MAS output stays
// inside MAS. Best-effort (never throws).
const TOKEN = () => process.env.MAS_BOT_TOKEN;
const CHAT = () => process.env.MAS_CHAT_ID;

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function notifyMas(text, buttons) {
  const body = {
    chat_id: CHAT(), text: String(text).slice(0, 4096), parse_mode: "HTML", disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  };
  await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => {});
}

// Chunk long content across messages (Telegram ~4096 char limit).
export async function notifyMasLong(text) {
  for (const p of String(text).match(/[\s\S]{1,3500}/g) || []) await notifyMas(p);
}
