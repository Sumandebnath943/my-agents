// agents/build-compass/collect.js — Build Compass COLLECTOR (runs ~3x/day, no LLM).
// Accumulates real demand into demand_items across the week so the weekly decider can weigh
// recurrence + engagement + comment-depth. Reddit adds post bodies (RSS); HN/Lobsters add
// engagement (points/comments) and — for the most-discussed HN threads — top comments.
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "../../lib/env.js";
import { subredditsNew } from "../../lib/reddit.js";
import { hnDemand, hnComments, lobsters } from "./sources.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const SUBS = ["SaaS", "webdev", "SideProject", "indiehackers", "automation", "Entrepreneur", "startups", "nocode"];

const items = [];
items.push(...(await hnDemand()));
items.push(...(await lobsters()));
try {
  items.push(...(await subredditsNew(SUBS, 60)).map((p) => ({ source: p.source, title: p.title, body: p.text, url: p.url, objectID: null, points: null, num_comments: null })));
} catch {}

// Enrich the most-discussed HN threads with their comments (the demand-requirement signal).
const topHn = items.filter((i) => i.objectID && (i.num_comments || 0) > 0).sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0)).slice(0, 12);
for (const it of topHn) it.top_comments = await hnComments(it.objectID);

let n = 0;
for (const it of items) {
  const key = it.url || it.title;
  if (!key) continue;
  const hash = createHash("sha1").update(key).digest("hex");
  const row = {
    source: it.source, title: (it.title || "").slice(0, 300), body: (it.body || "").slice(0, 1200),
    url: it.url || null, points: it.points ?? null, num_comments: it.num_comments ?? null, item_hash: hash,
  };
  if (it.top_comments) row.top_comments = it.top_comments; // never overwrite an existing digest with null
  try { await db.from("demand_items").upsert(row, { onConflict: "item_hash" }); n++; } catch {}
}
console.log(`collected/updated ${n} demand items (${items.length} fetched).`);
