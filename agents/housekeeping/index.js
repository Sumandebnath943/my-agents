// agents/housekeeping/index.js — weekly data retention. Prunes rows past their tier so
// the fleet stays comfortably under Supabase's free 500MB indefinitely. Best-effort per
// table (a missing table/column is skipped, never fatal). Financial history is kept long.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));

// table, timestamp column, and how long to keep (days).
const TIERS = [
  { table: "llm_metrics",     col: "ts",         days: 365 },  // keep 1 year for month-wise Team trends
  { table: "ops_events",      col: "ts",         days: 180 },
  { table: "agent_outputs",   col: "created_at", days: 180 },  // Responses feed
  { table: "finance",         col: "created_at", days: 730 },  // 24 months — financial history kept long
  { table: "finance_log",     col: "created_at", days: 730 },
  { table: "brand_snapshots", col: "created_at", days: 547 },  // ~18 months of weekly trend
  { table: "demand_items",    col: "created_at", days: 90 },   // Build Compass signals
  { table: "demand_signals",  col: "created_at", days: 90 },
  { table: "code_reviews",    col: "created_at", days: 180 },  // CTO history
];

const pruned = [];
for (const t of TIERS) {
  const cutoff = new Date(Date.now() - t.days * 86400000).toISOString();
  try {
    const { count } = await db.from(t.table).select("*", { count: "exact", head: true }).lt(t.col, cutoff);
    if (count > 0) {
      const { error } = await db.from(t.table).delete().lt(t.col, cutoff);
      if (!error) { pruned.push(`${t.table}: −${count}`); console.log(`pruned ${count} from ${t.table} (>${t.days}d)`); }
      else console.error(`prune ${t.table} failed:`, error.message);
    }
  } catch (e) { console.error(`skip ${t.table}:`, e.message); }
}

if (pruned.length) {
  await notifyTelegram(`🧹 <b>Housekeeping</b>\nPruned old rows past retention:\n${tgEscape(pruned.join("\n"))}`, { html: true });
}
console.log(pruned.length ? `Done. ${pruned.join(", ")}` : "Nothing to prune.");
