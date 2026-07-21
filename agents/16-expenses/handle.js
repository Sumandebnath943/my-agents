// agents/16-expenses/handle.js
// Handler for the inbox router: read a receipt photo with Gemini vision, log to `expenses`.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { downloadFileBase64 } from "../../lib/telegram-poll.js";
import { callLLM, parseJson } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { reconcileOne } from "./sweep.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// Constrain Gemini's output to exactly this shape (category is a fixed enum) — no more
// "wrong field / stray prose / bad category" parse failures from the vision model.
const EXPENSE_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    amount: { type: "number" },
    currency: { type: "string" },
    category: { type: "string", enum: ["food", "transport", "shopping", "bills", "other"] },
    spent_on: { type: "string", description: "YYYY-MM-DD" },
  },
  required: ["merchant", "amount", "currency", "category", "spent_on"],
};

export async function handleExpense(msg) {
  if (!msg.photoFileId) return false; // only act on photos
  const base64 = await downloadFileBase64(msg.photoFileId);

  const out = await callLLM(
    `Extract the expense from this receipt photo. Fill every field; if one is unreadable, use your best guess.`,
    { schema: EXPENSE_SCHEMA, images: [{ mimeType: "image/jpeg", base64 }] } // images → vision chain (Gemini → GPT-4o)
  );
  const e = parseJson(out);
  const { data: inserted } = await db.from("expenses").insert({
    merchant: e.merchant, amount: e.amount, currency: e.currency,
    category: e.category, spent_on: e.spent_on,
  }).select("id").maybeSingle();

  // Try to attach this receipt to the bank debit for the same purchase. If the SMS hasn't arrived
  // yet this stays `pending` and the weekly sweep retries it. The receipt NEVER becomes a
  // transaction — the ledger (finance) remains the only thing that counts toward spend.
  const rec = await reconcileOne(db, { id: inserted?.id, merchant: e.merchant, amount: e.amount, category: e.category, spent_on: e.spent_on });
  const linkNote = rec.status === "linked"
    ? "\n🔗 Matched to your bank debit"
    : rec.status === "ambiguous"
    ? "\n⚠️ Two bank debits match — review on the dashboard"
    : "\n⏳ No bank debit yet — will re-check";

  await notifyTelegram(
    `💸 <b>Expense logged</b>\n${tgEscape(e.merchant)} — ${tgEscape(e.currency)} ${tgEscape(e.amount)}\n📁 ${tgEscape(e.category)}${linkNote}`,
    { html: true }
  );
  return true;
}
