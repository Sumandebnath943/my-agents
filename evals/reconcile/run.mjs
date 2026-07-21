// evals/reconcile/run.mjs
// Guards receipt↔ledger reconciliation (agents/16-expenses/reconcile.js). Pure + offline.
//
// Two properties are non-negotiable and are what most of these cases exist to protect:
//   1. A receipt can NEVER become a transaction. Only `finance` counts toward spend, so nothing
//      here may inflate a total — the worst a bad match can do is mislabel one row.
//   2. Enrichment may never overwrite a category the owner TAUGHT the ledger. Re-categorising in
//      the dashboard writes a merchant→category rule; silently undoing that is exactly the kind of
//      invisible corruption this project keeps hunting.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { amountsMatch, dayDiff, findMatch, classify, enrichmentFor, summarize, isUninformativeMerchant, WINDOW_DAYS } from "../../agents/16-expenses/reconcile.js";

const NOW = new Date("2026-07-21T12:00:00Z");
const receipt = (amount, spent_on, extra = {}) => ({ id: 1, amount, spent_on, merchant: "Blue Tokai", category: "food", ...extra });
const debit = (id, amount, spent_on, extra = {}) => ({ id, amount, spent_on, direction: "debit", merchant: "UPI-4411", category: "other", ...extra });

export function run() {
  const basics = runCases("reconcile · amount + date primitives", [
    { id: "exact amount matches", check: () => amountsMatch(450, 450) === true },
    { id: "paisa precision respected", check: () => amountsMatch(450.5, 450.5) === true && amountsMatch(450.5, 450.51) === false },
    { id: "float noise tolerated", check: () => amountsMatch(0.1 + 0.2, 0.3) === true },
    { id: "string amount coerced", check: () => amountsMatch("450", 450) === true },
    { id: "no fuzzy tolerance (449 != 450)", check: () => amountsMatch(449, 450) === false },
    { id: "null amount never matches", check: () => amountsMatch(null, 450) === false },
    { id: "dayDiff counts days", check: () => dayDiff("2026-07-21", "2026-07-18") === 3 },
    { id: "dayDiff is signed", check: () => dayDiff("2026-07-18", "2026-07-21") === -3 },
    { id: "dayDiff tolerates timestamps", check: () => dayDiff("2026-07-21T09:00:00Z", "2026-07-21") === 0 },
    { id: "dayDiff invalid -> null", check: () => dayDiff("nope", "2026-07-21") === null },
  ], (c) => ({ ok: c.check() }));

  const matching = runCases("reconcile · matching", [
    { id: "same day, same amount -> match", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-20")]).match?.id === 7 },
    { id: "matches across the window", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-16")]).match?.id === 7 },
    { id: "bank debit AFTER the receipt still matches", check: () => findMatch(receipt(450, "2026-07-16"), [debit(7, 450, "2026-07-20")]).match?.id === 7 },
    { id: "outside the window -> no match", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-10")]).match === null },
    { id: "different amount -> no match", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 460, "2026-07-20")]).match === null },
    { id: "credits are never matched", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-20", { direction: "credit" })]).match === null },
    { id: "nearest date wins", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-17"), debit(8, 450, "2026-07-19")]).match?.id === 8 },
    { id: "TIE -> refuses to guess (ambiguous)", check: () => { const r = findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-19"), debit(8, 450, "2026-07-21")]); return r.match === null && r.ambiguous === true; } },
    { id: "two same-day identical debits -> ambiguous", check: () => findMatch(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-20"), debit(8, 450, "2026-07-20")]).ambiguous === true },
    { id: "empty ledger -> no match, not ambiguous", check: () => { const r = findMatch(receipt(450, "2026-07-20"), []); return r.match === null && r.ambiguous === false; } },
    { id: "malformed rows never throw", check: () => findMatch(receipt(450, "2026-07-20"), [null, {}, { amount: "x" }]).match === null },
    { id: "null debits safe", check: () => findMatch(receipt(450, "2026-07-20"), null).match === null },
  ], (c) => ({ ok: c.check() }));

  const status = runCases("reconcile · status (a receipt is never a transaction)", [
    { id: "matched -> linked + finance_id", check: () => { const r = classify(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-20")], { now: NOW }); return r.status === "linked" && r.finance_id === 7; } },
    { id: "fresh + unmatched -> pending (SMS may still arrive)", check: () => classify(receipt(450, "2026-07-20"), [], { now: NOW }).status === "pending" },
    { id: "at the window edge -> still pending", check: () => classify(receipt(450, "2026-07-16"), [], { now: NOW }).status === "pending" },
    { id: "past the window -> unmatched (flagged)", check: () => classify(receipt(450, "2026-07-10"), [], { now: NOW }).status === "unmatched" },
    { id: "ambiguous keeps finance_id null", check: () => { const r = classify(receipt(450, "2026-07-20"), [debit(7, 450, "2026-07-19"), debit(8, 450, "2026-07-21")], { now: NOW }); return r.status === "ambiguous" && r.finance_id === null; } },
    { id: "NO status ever implies creating a transaction", check: () => ["linked", "pending", "unmatched", "ambiguous"].every((s) => s !== "created" && s !== "inserted") },
    { id: "unparseable date -> pending, never unmatched", check: () => classify(receipt(450, "garbage"), [], { now: NOW }).status === "pending" },
    { id: "window constant is 5 days", check: () => WINDOW_DAYS === 5 },
  ], (c) => ({ ok: c.check() }));

  // The bank names the payment RAIL ("UPI-99881"), the receipt names the shop ("Blue Tokai").
  // Upgrading that is the whole point — but a real name must never be clobbered.
  const merchants = runCases("reconcile · which merchants are worth replacing", [
    { id: "empty is uninformative", check: () => isUninformativeMerchant("") === true },
    { id: "null is uninformative", check: () => isUninformativeMerchant(null) === true },
    { id: "'unknown' is uninformative", check: () => isUninformativeMerchant("unknown") === true },
    { id: "UPI handle is uninformative", check: () => isUninformativeMerchant("UPI-99881") === true },
    { id: "lowercase upi handle too", check: () => isUninformativeMerchant("upi/8827361") === true },
    { id: "ACH DR is uninformative", check: () => isUninformativeMerchant("ACH DR") === true },
    { id: "POS terminal is uninformative", check: () => isUninformativeMerchant("POS 4411") === true },
    { id: "pure digits is uninformative", check: () => isUninformativeMerchant("902384") === true },
    { id: "mostly-digits handle is uninformative", check: () => isUninformativeMerchant("PAYTM-1234567") === true },
    { id: "two-letter stub is uninformative", check: () => isUninformativeMerchant("XY-9931") === true },
    // must NOT be replaced
    { id: "'Starbucks' is a real name", check: () => isUninformativeMerchant("Starbucks") === false },
    { id: "'PVR LTD' is a real name", check: () => isUninformativeMerchant("PVR LTD") === false },
    { id: "'Blue Tokai Coffee' is a real name", check: () => isUninformativeMerchant("Blue Tokai Coffee") === false },
    { id: "'Amazon Pay' is a real name", check: () => isUninformativeMerchant("Amazon Pay") === false },
    { id: "'SWIGGY*ORDER123' still readable", check: () => isUninformativeMerchant("SWIGGY*ORDER123") === false },
    { id: "'7-Eleven' survives its digit", check: () => isUninformativeMerchant("7-Eleven") === false },
  ], (c) => ({ ok: c.check() }));

  const enrich = runCases("reconcile · enrichment (must not undo owner corrections)", [
    { id: "upgrades a UPI handle to the shop name", check: () => enrichmentFor({ merchant: "UPI-99881", category: "food" }, receipt(450, "2026-07-20")).merchant === "Blue Tokai" },
    { id: "does NOT downgrade a real name to a handle", check: () => enrichmentFor({ merchant: "Starbucks", category: "food" }, { merchant: "UPI-77", category: "food" }).merchant === undefined },
    { id: "does not swap one useless string for another", check: () => enrichmentFor({ merchant: "UPI-1", category: "food" }, { merchant: "UPI-2", category: "food" }).merchant === undefined },
    { id: "fills a vague UPI merchant", check: () => enrichmentFor({ merchant: "", category: "food" }, receipt(450, "2026-07-20")).merchant === "Blue Tokai" },
    { id: "fills a null merchant", check: () => enrichmentFor({ merchant: null, category: "food" }, receipt(450, "2026-07-20")).merchant === "Blue Tokai" },
    { id: "fills an 'unknown' merchant", check: () => enrichmentFor({ merchant: "unknown", category: "food" }, receipt(450, "2026-07-20")).merchant === "Blue Tokai" },
    { id: "NEVER overwrites a real merchant", check: () => enrichmentFor({ merchant: "Starbucks", category: "food" }, receipt(450, "2026-07-20")).merchant === undefined },
    { id: "fills category 'other'", check: () => enrichmentFor({ merchant: "X", category: "other" }, receipt(450, "2026-07-20")).category === "food" },
    { id: "fills category 'misc'", check: () => enrichmentFor({ merchant: "X", category: "misc" }, receipt(450, "2026-07-20")).category === "food" },
    { id: "fills a null category", check: () => enrichmentFor({ merchant: "X", category: null }, receipt(450, "2026-07-20")).category === "food" },
    { id: "NEVER overwrites a taught category (the learning loop)", check: () => enrichmentFor({ merchant: "X", category: "groceries" }, receipt(450, "2026-07-20")).category === undefined },
    { id: "never overwrites 'emi'", check: () => enrichmentFor({ merchant: "X", category: "emi" }, receipt(450, "2026-07-20")).category === undefined },
    { id: "empty receipt fields change nothing", check: () => Object.keys(enrichmentFor({ merchant: "", category: "other" }, { merchant: "", category: "" })).length === 0 },
    { id: "patch never touches amount", check: () => enrichmentFor({ merchant: "", category: "other", amount: 999 }, receipt(450, "2026-07-20")).amount === undefined },
    { id: "patch never touches direction or spent_on", check: () => { const p = enrichmentFor({ merchant: "", category: "other" }, receipt(450, "2026-07-20")); return p.direction === undefined && p.spent_on === undefined; } },
    { id: "long merchant truncated", check: () => enrichmentFor({ merchant: "" }, { merchant: "z".repeat(200), category: "" }).merchant.length === 120 },
    { id: "null inputs safe", check: () => Object.keys(enrichmentFor(null, null)).length === 0 },
  ], (c) => ({ ok: c.check() }));

  const sum = runCases("reconcile · summary", [
    { id: "counts each status", check: () => { const c = summarize([{ status: "linked" }, { status: "linked" }, { status: "pending" }]); return c.linked === 2 && c.pending === 1; } },
    { id: "counts enrichments", check: () => summarize([{ status: "linked", enriched: true }]).enriched === 1 },
    { id: "unknown status ignored", check: () => summarize([{ status: "weird" }]).linked === 0 },
    { id: "empty/null safe", check: () => summarize(null).linked === 0 },
  ], (c) => ({ ok: c.check() }));

  return [basics, matching, status, merchants, enrich, sum];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
