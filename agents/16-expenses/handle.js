// agents/16-expenses/handle.js
// Handler for the inbox router: read a receipt photo with Gemini vision, log to `expenses`.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { downloadFileBase64 } from "../../lib/telegram-poll.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

export async function handleExpense(msg) {
  if (!msg.photoFileId) return false; // only act on photos
  const base64 = await downloadFileBase64(msg.photoFileId);

  const out = await callGemini(
    `Extract the expense from this receipt photo. Return ONLY JSON:
{"merchant":"...","amount":12.34,"currency":"INR","category":"food|transport|shopping|bills|other","spent_on":"YYYY-MM-DD"}.
If a field is unreadable, use your best guess.`,
    { json: true, images: [{ mimeType: "image/jpeg", base64 }] }
  );
  const e = parseJson(out);
  await db.from("expenses").insert({
    merchant: e.merchant, amount: e.amount, currency: e.currency,
    category: e.category, spent_on: e.spent_on,
  });
  await notifyTelegram(`💸 Logged: *${e.merchant}* ${e.currency} ${e.amount} (${e.category})`);
  return true;
}
