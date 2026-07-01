// lib/telegram-poll.js
import { env } from "./env.js";
import { getState, setState } from "./store.js";

// Returns an array of new messages (text + any photo) since the last poll.
// Tracks the Telegram update offset in the kv store so nothing is processed twice.
export async function getNewMessages() {
  const offset = (await getState("tg:offset", 0)) || 0;
  const res = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/getUpdates?offset=${offset + 1}&timeout=0`
  );
  const data = await res.json();
  const updates = data.result || [];
  if (!updates.length) return [];

  const messages = [];
  for (const u of updates) {
    const m = u.message;
    if (m) {
      messages.push({
        updateId: u.update_id,
        text: m.text || m.caption || "",
        photoFileId: m.photo ? m.photo[m.photo.length - 1].file_id : null, // largest size
        date: m.date,
      });
    }
  }
  // Advance the offset past the last update we just read.
  await setState("tg:offset", updates[updates.length - 1].update_id);
  return messages;
}

// Download a Telegram photo (or any file) and return it as base64.
export async function downloadFileBase64(fileId) {
  const info = await fetch(
    `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/getFile?file_id=${fileId}`
  ).then((r) => r.json());
  const path = info.result.file_path;
  const bin = await fetch(
    `https://api.telegram.org/file/bot${env("TELEGRAM_BOT_TOKEN")}/${path}`
  ).then((r) => r.arrayBuffer());
  return Buffer.from(bin).toString("base64");
}
