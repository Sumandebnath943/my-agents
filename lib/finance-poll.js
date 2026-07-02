// lib/finance-poll.js
// A SEPARATE, finance-scoped Telegram reader for the #20 ledger. Uses its own bot
// (FINANCE_BOT_TOKEN) so bank/UPI data never touches the main bot's history, and its own
// offset key (tg:offset:finance) so it never collides with the main poller. LOCKED: it
// ignores any update that isn't from your own FINANCE_CHAT_ID.
import { env } from "./env.js";
import { getState, setState } from "./store.js";

export async function getFinanceMessages() {
  const offset = (await getState("tg:offset:finance", 0)) || 0;
  const res = await fetch(
    `https://api.telegram.org/bot${env("FINANCE_BOT_TOKEN")}/getUpdates?offset=${offset + 1}&timeout=0`
  );
  const data = await res.json();
  const updates = data.result || [];
  if (!updates.length) return [];

  // LOCK THE BOT: only accept messages from your own chat id.
  const mine = String(env("FINANCE_CHAT_ID"));
  const msgs = updates
    .filter((u) => u.message && String(u.message.chat.id) === mine)
    .map((u) => ({ text: u.message.text || "", date: u.message.date }));

  // Advance the offset past everything we just read (even filtered-out updates).
  await setState("tg:offset:finance", updates[updates.length - 1].update_id);
  return msgs;
}
