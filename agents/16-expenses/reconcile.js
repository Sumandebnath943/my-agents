// agents/16-expenses/reconcile.js
// Reconciles RECEIPT PHOTOS (`expenses`, #16) against the SMS BANK LEDGER (`finance`, #20).
//
// The two systems were completely disjoint: photograph a restaurant bill AND get the bank SMS for
// the same meal, and it landed twice as two unrelated records that neither system knew about.
//
// OWNER POLICY (locked, unchanged by this file): the ledger logs DEBITS ONLY and the bank SMS is
// the source of truth. So a receipt may only ENRICH a bank debit — it can never create a
// transaction, and totals can never inflate. A receipt with no bank match is FLAGGED for review,
// never silently added. (`finance` remains the only thing the weekly review sums.)
//
// Matching is deliberately conservative: an exact amount inside a small date window. If two debits
// are equally plausible, we mark it `ambiguous` for a human rather than guessing — enriching the
// wrong row is a silent corruption, which is exactly the failure mode this project keeps fighting.
//
// Pure — no DB, no network — so it can be unit-eval'd offline.

export const WINDOW_DAYS = 5;   // how far either side of the receipt a bank debit may sit
export const STATUSES = ["pending", "linked", "unmatched", "ambiguous"];

/** Categories that mean "we don't really know" — the only ones a receipt may overwrite. */
const VAGUE_CATEGORIES = new Set([null, undefined, "", "other", "misc", "unknown"]);
/** Merchant values that carry no information. */
const VAGUE_MERCHANTS = new Set(["", "unknown", "n/a", "na", "-", "null"]);
/** Payment-rail handles: "UPI-99881", "ACH DR", "POS 4411" — the rail, not the shop. */
const RAIL_RE = /^(upi|ach|neft|imps|rtgs|pos|atm|txn|ref|inb|mmt|bil|nach)[\s\-_/*]*\w*$/i;

/**
 * Is a ledger merchant too uninformative to be worth keeping?
 *
 * This is the whole point of the feature: a bank SMS usually names the payment RAIL ("UPI-99881"),
 * not the shop, while the receipt has "Blue Tokai". But it must never clobber a real name the
 * owner sees value in — so anything with genuine words is left alone.
 */
export function isUninformativeMerchant(v) {
  const s = String(v ?? "").trim();
  if (!s) return true;
  if (VAGUE_MERCHANTS.has(s.toLowerCase())) return true;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (!letters) return true;                       // pure digits/symbols
  if (RAIL_RE.test(s)) return true;                // a payment-rail handle
  if (letters < 3) return true;                    // "XY-9931"
  const digits = (s.match(/\d/g) || []).length;
  const dense = s.replace(/\s/g, "").length || 1;
  return digits > 0 && digits / dense >= 0.4;      // mostly numeric = a reference, not a name
}

const day = (d) => {
  const t = new Date(`${String(d ?? "").slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Whole days between two YYYY-MM-DD dates, or null if either is unparseable. */
export function dayDiff(a, b) {
  const [x, y] = [day(a), day(b)];
  if (x === null || y === null) return null;
  return Math.round((x - y) / 86400000);
}

/** Amounts must match to the paisa. Both sides describe the same purchase, so no fuzzy tolerance. */
export function amountsMatch(a, b) {
  const [x, y] = [Number(a), Number(b)];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 100) === Math.round(y * 100);
}

/**
 * Find the bank debit that corresponds to a receipt.
 * @param {{amount:number, spent_on:string}} receipt
 * @param {Array<{id:number, amount:number, direction:string, spent_on:string}>} debits
 * @returns {{match:object|null, ambiguous:boolean, candidates:number}}
 */
export function findMatch(receipt, debits, { windowDays = WINDOW_DAYS } = {}) {
  const rows = (Array.isArray(debits) ? debits : []).filter(Boolean);
  const candidates = rows
    .filter((d) => d.direction !== "credit" && amountsMatch(d.amount, receipt?.amount))
    .map((d) => ({ row: d, dist: Math.abs(dayDiff(d.spent_on, receipt?.spent_on) ?? Infinity) }))
    .filter((c) => Number.isFinite(c.dist) && c.dist <= windowDays)
    .sort((a, b) => a.dist - b.dist || a.row.id - b.row.id);

  if (!candidates.length) return { match: null, ambiguous: false, candidates: 0 };
  // A unique nearest date wins. A tie means two equally plausible debits — refuse to guess.
  const tied = candidates.filter((c) => c.dist === candidates[0].dist);
  if (tied.length > 1) return { match: null, ambiguous: true, candidates: candidates.length };
  return { match: candidates[0].row, ambiguous: false, candidates: candidates.length };
}

/**
 * Decide what a receipt's match_status should be right now.
 * A receipt still inside the window may simply be waiting for its bank SMS to arrive, so it stays
 * `pending` rather than being declared unmatched.
 */
export function classify(receipt, debits, { now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const { match, ambiguous, candidates } = findMatch(receipt, debits, { windowDays });
  if (match) return { status: "linked", finance_id: match.id, match, candidates };
  if (ambiguous) return { status: "ambiguous", finance_id: null, match: null, candidates };
  const age = dayDiff(now.toISOString().slice(0, 10), receipt?.spent_on);
  if (age === null || age <= windowDays) return { status: "pending", finance_id: null, match: null, candidates: 0 };
  return { status: "unmatched", finance_id: null, match: null, candidates: 0 };
}

/**
 * What (if anything) the receipt should write onto the matched bank row.
 *
 * Deliberately narrow. The ledger has a LEARNING LOOP — re-categorising a transaction in the
 * dashboard writes a merchant→category rule that the ingest then applies. Overwriting a category
 * the owner taught it would silently undo that. So a receipt only fills in blanks: an empty or
 * meaningless merchant, and a category that is still the "we don't know" default.
 * @returns {object} patch — empty when there is nothing safe to improve
 */
export function enrichmentFor(financeRow, receipt) {
  const patch = {};
  const rm = String(receipt?.merchant ?? "").trim();
  // Only upgrade when the receipt's name is itself informative — swapping one useless string for
  // another is churn, and swapping a real name for a useless one is a regression.
  if (rm && !isUninformativeMerchant(rm) && isUninformativeMerchant(financeRow?.merchant)) {
    patch.merchant = rm.slice(0, 120);
  }

  const fc = financeRow?.category == null ? null : String(financeRow.category).trim().toLowerCase();
  const rc = String(receipt?.category ?? "").trim().toLowerCase();
  if (rc && VAGUE_CATEGORIES.has(fc)) patch.category = rc;
  return patch;
}

/** Human-readable summary of a sweep, so a run always reports what it did. */
export function summarize(results) {
  const counts = { linked: 0, pending: 0, unmatched: 0, ambiguous: 0, enriched: 0 };
  for (const r of results || []) {
    if (counts[r?.status] != null) counts[r.status]++;
    if (r?.enriched) counts.enriched++;
  }
  return counts;
}
