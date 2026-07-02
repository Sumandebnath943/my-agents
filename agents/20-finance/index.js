// agents/20-finance/index.js
// SMS Financial Ledger — ingest. Reads new bank/UPI SMS forwarded to the finance bot,
// strips masked account fragments BEFORE storing, extracts the transaction with Groq
// (private — financial data NEVER goes to Gemini), and upserts with a unique raw_hash so
// the 20-min poll can't double-count the same SMS.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "../../lib/env.js";
import { getFinanceMessages } from "../../lib/finance-poll.js";
import { callGroq, parseJson } from "../../lib/llm.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// Only process messages that look like a bank debit/credit alert.
const BANK_RE = /(debited|credited|spent|paid|txn|a\/c|upi|rs\.?|inr|₹)/i;
// STRIP BEFORE STORING: remove masked account fragments like XX3491 / a/c no.
const strip = (t) => t.replace(/\b(?:x{2,}\d+|a\/c\s*\w*\d+)\b/gi, "[acct]");

const messages = await getFinanceMessages();
let logged = 0;

for (const m of messages) {
  if (!BANK_RE.test(m.text)) continue;                          // ignore non-bank
  if (/\b(otp|code|password|login)\b/i.test(m.text)) continue;  // belt-and-braces: never store OTPs
  const clean = strip(m.text);
  const hash = createHash("sha1").update(clean).digest("hex");

  const out = await callGroq(   // Groq only — financial data never goes to Gemini
    [
      { role: "system", content: 'Extract a transaction. JSON only: {"merchant":"...","amount":123.45,"direction":"debit|credit"}. If not a real transaction, return {"merchant":null}.' },
      { role: "user", content: clean },
    ],
    { json: true }
  );
  let t = {};
  try { t = parseJson(out); } catch { continue; }
  if (!t.merchant) continue;

  // Upsert with raw_hash unique -> a duplicate SMS won't double-count.
  await db.from("finance").upsert(
    { merchant: t.merchant, amount: t.amount, direction: t.direction, raw_hash: hash, spent_on: new Date().toISOString().slice(0, 10) },
    { onConflict: "raw_hash", ignoreDuplicates: true }
  );
  logged++;
}
console.log(`Logged ${logged} transaction(s).`);
