#!/usr/bin/env node
// scripts/chain-crosscheck.mjs — does every provider in an agent's chain actually have its key?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// An agent's fallback chain is declared centrally in lib/routing.js, but the API keys that make
// each hop reachable are provisioned PER WORKFLOW in YAML. Nothing connected the two, and
// lib/llm.js skips a keyless provider SILENTLY — by design, so a missing key can never crash a
// run. The cost of that silence is a chain that quietly runs shorter than it reads.
//
// Found on 1 Sep 2026: `job-agent` declares [openai → gemini → groq → openrouter] but its workflow
// never passed GROQ_API_KEY. So when OpenAI's credits ran out, its real chain was
// [openai(dead) → gemini(throttled) → openrouter(never works)] and calls failed outright. Groq —
// 100% healthy, free, and using under 1% of its daily budget — sat right there in the chain,
// unreachable. Eleven agents were running with a hole like this.
//
// This is the same shape of bug as scripts/cron-crosscheck.mjs in the dashboard repo: two places
// that must agree, no check that they do. Same remedy.
//
// USAGE
//   node scripts/chain-crosscheck.mjs          exit 0 = clean, exit 1 = at least one real gap
//
// Deliberately NOT part of `npm run eval:all` — the eval suite is a fixed-count contract and this
// asserts something about YAML rather than about logic. Run it before committing a workflow or a
// change to lib/routing.js.
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from "node:fs";
import { AGENT_CHAIN, CHAINS, chainFor } from "../lib/routing.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WF = `${ROOT}/.github/workflows`;

// Provider -> the env var lib/llm.js looks for.
//
// ⚠️ READ AS TEXT, NEVER IMPORTED. Importing lib/llm.js would pull in lib/env.js, which loads the
// whole .env into process.env. This script only needs to know the NAMES of the key variables, so
// loading their values would be pure unnecessary exposure — one careless console.log away from
// printing a live secret. lib/routing.js above is safe: it is data-only and imports nothing.
//
// Parsing the text still keeps a single source of truth, and the assertion below fails loudly if
// the shape of lib/llm.js changes, rather than silently checking against a stale map.
const KEY_ENV = { gemini: "GEMINI_API_KEY" };   // gemini has its own REST shape, not in OAI
{
  const src = readFileSync(`${ROOT}/lib/llm.js`, "utf8");
  const oai = src.slice(src.indexOf("const OAI = {"));
  for (const m of oai.matchAll(/^\s{2}(\w+):\s*\{[^}]*?keyEnv:\s*"([A-Z0-9_]+)"/gm)) KEY_ENV[m[1]] = m[2];
}
const named = [...new Set(Object.values(CHAINS).flatMap((c) => c.order))];
const unmapped = named.filter((p) => !KEY_ENV[p]);
if (unmapped.length) {
  console.error(`✗ cannot resolve the key env var for: ${unmapped.join(", ")}\n` +
    `  lib/llm.js's OAI block no longer matches this script's parser — fix the regex above.`);
  process.exit(2);
}

// ── does THIS entry script actually reach lib/llm.js? ───────────────────────────────────────
// A job that never touches lib/llm.js cannot be hurt by a missing provider key, and flagging it
// would train the reader to ignore this script — so resolve it precisely rather than by directory.
// Several agent folders hold both an LLM-using script and a plain one (10-linkedin drafts with an
// LLM, posts without), so a per-directory answer is wrong in both directions.
//
// Follows relative imports transitively from the entry file. Depth is bounded by the visited set.
const _usesLLM = new Map();
function reachesLLM(absFile, seen = new Set()) {
  const norm = absFile.replace(/\\/g, "/");
  if (_usesLLM.has(norm)) return _usesLLM.get(norm);
  if (seen.has(norm)) return false;
  seen.add(norm);
  let src;
  try { src = readFileSync(norm, "utf8"); } catch { return false; }
  if (/from\s+["'][^"']*lib\/llm\.js["']/.test(src)) { _usesLLM.set(norm, true); return true; }
  const dir = norm.replace(/\/[^/]*$/, "");
  let hit = false;
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    let target = `${dir}/${m[1]}`.replace(/\/\.\//g, "/");
    while (/\/[^/]+\/\.\.\//.test(target)) target = target.replace(/\/[^/]+\/\.\.\//, "/");
    if (reachesLLM(target, seen)) { hit = true; break; }
  }
  _usesLLM.set(norm, hit);
  return hit;
}

// ── split a workflow into jobs, and collect the env keys visible to each ─────────────────────
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  // Workflow-level env: is available to every job.
  const global = new Set();
  let inGlobalEnv = false;
  for (const l of lines) {
    if (/^env:\s*$/.test(l)) { inGlobalEnv = true; continue; }
    if (inGlobalEnv) {
      if (/^\S/.test(l)) inGlobalEnv = false;
      else { const m = l.match(/([A-Z0-9_]+)\s*:/); if (m) global.add(m[1]); }
    }
  }
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return [];
  const heads = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) heads.push(i);
  }
  return heads.map((start, idx) => {
    const end = idx + 1 < heads.length ? heads[idx + 1] : lines.length;
    const block = lines.slice(start, end).join("\n");
    const name = lines[start].trim().replace(/:$/, "");
    const agent = (block.match(/AGENT_NAME:\s*([A-Za-z0-9._:-]+)/) || [])[1];
    const keys = new Set([...global, ...[...block.matchAll(/([A-Z0-9_]*API_KEY)\s*:/g)].map((m) => m[1])]);
    const entry = (block.match(/node\s+(agents\/[^\s]+)/) || [])[1];
    return { job: name, agent, keys, entry };
  });
}

// ── run the check ───────────────────────────────────────────────────────────────────────────
const gaps = [], skipped = [];
for (const f of readdirSync(WF).filter((f) => /\.(yml|yaml)$/.test(f)).sort()) {
  for (const j of parseWorkflow(readFileSync(`${WF}/${f}`, "utf8"))) {
    if (!j.agent) continue;
    const callsLLM = j.entry ? reachesLLM(`${ROOT}/${j.entry}`) : false;
    const { order } = chainFor(j.agent, undefined, false);
    const missing = order.filter((p) => !j.keys.has(KEY_ENV[p]));
    if (!missing.length) continue;
    const rec = { f, ...j, chain: AGENT_CHAIN[j.agent] || "public", order, missing, callsLLM };
    (callsLLM ? gaps : skipped).push(rec);
  }
}

const line = (r) =>
  `  ${r.f}:${r.job}  agent=${r.agent}  chain=${r.chain}\n` +
  `      declared : ${r.order.join(" → ")}\n` +
  `      effective: ${r.order.filter((p) => !r.missing.includes(p)).join(" → ") || "NOTHING"}\n` +
  `      MISSING  : ${r.missing.map((p) => KEY_ENV[p]).join(", ")}`;

if (gaps.length) {
  console.log(`✗ ${gaps.length} job(s) run an LLM agent whose chain has an unreachable hop:\n`);
  for (const r of gaps) console.log(line(r) + "\n");
}
if (skipped.length) {
  console.log(`ℹ ${skipped.length} job(s) also lack chain keys but never import lib/llm.js — not a fault:`);
  for (const r of skipped) console.log(`    ${r.f}:${r.job} (${r.agent}) missing ${r.missing.map((p) => KEY_ENV[p]).join(", ")}`);
  console.log("");
}
if (!gaps.length) {
  console.log("✓ clean — every provider in every LLM agent's chain has its key in that agent's workflow.");
  process.exit(0);
}
console.log("Fix by adding the named secret(s) to that job's `env:`, or by changing the agent's chain\nin lib/routing.js so it only names providers that job can actually reach.");
process.exit(1);
