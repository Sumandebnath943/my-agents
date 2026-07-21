// agents/16-expenses/sweep.js
// The DB half of receipt↔ledger reconciliation. The pure matching rules live in ./reconcile.js.
//
// Why a sweep and not just a check at capture time: the receipt photo and the bank SMS arrive in
// an unpredictable order. Photograph the bill before the SMS lands and an at-capture match finds
// nothing. So `reconcileOne()` runs on capture (catches the common case) and `sweep()` re-tries
// everything still open (catches the rest). Both are best-effort: if sql/expenses_reconcile.sql
// hasn't been run, the columns are missing, every write no-ops, and #16/#20 behave as before.
import { classify, enrichmentFor, summarize, WINDOW_DAYS } from "./reconcile.js";

/** Bank debits that could plausibly match a receipt on `date`. */
async function debitsNear(db, date, windowDays = WINDOW_DAYS) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return [];
  const from = new Date(d.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  const to = new Date(d.getTime() + windowDays * 86400000).toISOString().slice(0, 10);
  const { data, error } = await db.from("finance")
    .select("id,merchant,amount,category,direction,spent_on")
    .eq("direction", "debit").gte("spent_on", from).lte("spent_on", to).limit(200);
  if (error) throw error;
  return data || [];
}

/**
 * Reconcile ONE receipt. Returns { status, finance_id, enriched } — never throws.
 * Enrichment is intentionally narrow (see enrichmentFor): a receipt fills blanks on the bank row,
 * it never overwrites a category the owner taught the ledger via the finance_rules learning loop.
 */
export async function reconcileOne(db, receipt, { now = new Date() } = {}) {
  try {
    const debits = await debitsNear(db, receipt.spent_on);
    const res = classify(receipt, debits, { now });

    let enriched = false;
    if (res.status === "linked" && res.match) {
      const patch = enrichmentFor(res.match, receipt);
      if (Object.keys(patch).length) {
        const { error } = await db.from("finance").update(patch).eq("id", res.match.id);
        if (!error) enriched = true;
      }
    }

    if (receipt.id != null) {
      const { error } = await db.from("expenses").update({
        finance_id: res.finance_id,
        match_status: res.status,
        matched_at: res.status === "linked" ? new Date().toISOString() : null,
      }).eq("id", receipt.id);
      // A missing column means the setup SQL hasn't been run — say so once, don't pretend it worked.
      if (error) return { status: res.status, finance_id: res.finance_id, enriched, error: error.message };
    }
    return { status: res.status, finance_id: res.finance_id, enriched };
  } catch (e) {
    return { status: "pending", finance_id: null, enriched: false, error: e.message };
  }
}

/**
 * Re-try every receipt that is still open (pending/ambiguous, or never classified).
 * @returns {{counts:object, checked:number, error:string|null}}
 */
export async function sweep(db, { days = 45, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  let receipts;
  try {
    const { data, error } = await db.from("expenses")
      .select("id,merchant,amount,category,spent_on,match_status")
      .gte("spent_on", since).order("spent_on", { ascending: false }).limit(200);
    if (error) throw error;
    receipts = (data || []).filter((r) => !r.match_status || r.match_status === "pending" || r.match_status === "ambiguous");
  } catch (e) {
    return { counts: summarize([]), checked: 0, error: e.message };
  }

  const results = [];
  for (const r of receipts) results.push(await reconcileOne(db, r, { now }));
  const firstError = results.find((r) => r.error)?.error || null;
  return { counts: summarize(results), checked: receipts.length, error: firstError };
}
