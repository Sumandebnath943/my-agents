// lib/memory.js — Node-native adaptive memory on the EXISTING Supabase project (no new service).
// Implements the Mem0 *pattern* — scoped memories, semantic recall, dedup + conflict resolution —
// using the same approach ECHO already uses (Gemini embeddings + cosine in JS over a stored vector).
// Agents remember preferences/facts across runs and share them.
//
// Best-effort by design: every function swallows failures (returns [] / null) so a memory hiccup
// never breaks the agent calling it. Needs the `agent_memories` table (see sql/agent_memories.sql).
import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { callGroq, parseJson } from "./llm.js";

let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

const DEDUP_THRESHOLD = 0.94; // cosine ≥ this = "the same memory" → update instead of duplicate

// 768-dim embedding via Gemini text-embedding-004 (free) — same model ECHO uses.
export async function embed(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${env("GEMINI_API_KEY")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text: String(text).slice(0, 8000) }] } }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}`);
  return (await res.json()).embedding?.values || null;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Fetch stored memories for a scope (optionally a specific key), newest first.
async function fetchScope(scope, scopeKey, limit = 500) {
  let q = db().from("agent_memories").select("id,scope,scope_key,content,embedding,source,updated_at");
  if (scope) q = q.eq("scope", scope);
  if (scopeKey) q = q.eq("scope_key", scopeKey);
  const { data, error } = await q.order("updated_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Save a memory. Dedups: if a near-identical memory already exists in the same scope, UPDATE it
 * (newer wins — simple conflict resolution) instead of inserting a duplicate.
 * @param {string} content
 * @param {{scope?: "user"|"agent"|"session", scopeKey?: string, source?: string}} [opts]
 * @returns {Promise<{id?: number, action: "insert"|"update"|"skip"}>}
 */
export async function remember(content, { scope = "user", scopeKey = "suman", source = "" } = {}) {
  try {
    if (!content || !String(content).trim()) return { action: "skip" };
    const vec = await embed(content);
    if (!vec) return { action: "skip" };
    const existing = await fetchScope(scope, scopeKey).catch(() => []);
    const dup = existing.map((r) => ({ r, s: cosine(vec, r.embedding) })).sort((a, b) => b.s - a.s)[0];
    if (dup && dup.s >= DEDUP_THRESHOLD) {
      await db().from("agent_memories").update({ content, embedding: vec, source, updated_at: new Date().toISOString() }).eq("id", dup.r.id);
      return { id: dup.r.id, action: "update" };
    }
    const { data } = await db().from("agent_memories").insert({ scope, scope_key: scopeKey, content, embedding: vec, source }).select("id").single();
    return { id: data?.id, action: "insert" };
  } catch (e) {
    console.error("memory.remember failed (ignored):", e.message);
    return { action: "skip" };
  }
}

/**
 * Recall the most relevant memories for a query within a scope.
 * @returns {Promise<Array<{content: string, score: number, source: string}>>}
 */
export async function recall(query, { scope = "user", scopeKey = "suman", k = 5 } = {}) {
  try {
    const qv = await embed(query);
    if (!qv) return [];
    const rows = await fetchScope(scope, scopeKey);
    return rows
      .map((r) => ({ content: r.content, source: r.source, score: cosine(qv, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  } catch (e) {
    console.error("memory.recall failed (ignored):", e.message);
    return [];
  }
}

// Extract durable facts/preferences from a raw interaction and remember each (deduped).
// Use for "learn from what the user did/said" moments. Best-effort.
export async function extractAndRemember(text, { scope = "user", scopeKey = "suman", source = "" } = {}) {
  try {
    const out = await callGroq(
      [
        { role: "system", content: "Extract durable, reusable facts or preferences worth remembering long-term (not one-off chatter). Reply ONLY JSON." },
        { role: "user", content: `From this, list 0-4 concise memories (each a standalone sentence). Return {"memories":["...","..."]}.\n\n${text}` },
      ],
      { json: true }
    );
    const mems = parseJson(out).memories || [];
    let saved = 0;
    for (const m of mems) { const r = await remember(m, { scope, scopeKey, source }); if (r.action !== "skip") saved++; }
    return saved;
  } catch (e) {
    console.error("memory.extractAndRemember failed (ignored):", e.message);
    return 0;
  }
}
