#!/usr/bin/env node
// tools/run-gate.mjs — has this scheduled slot already been done?
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// GitHub stopped reliably dispatching `schedule` events for this repo on 2026-08-27. A dispatcher
// on the control dashboard fires the runs GitHub drops, which works — but GitHub frequently
// delivers the SAME run five or six hours later anyway, and then the agent runs twice. On 31 Aug
// the dispatcher fired 16 runs and at least 6 doubled.
//
// The dispatcher cannot prevent this on its own. Before firing it can ask "has this already run?"
// but not "is GitHub about to deliver it?" — nothing in the API answers that. Waiting long enough
// to be sure is the only alternative, and that just restores the six-hour lateness.
//
// This script answers the question at the only moment it CAN be answered: when GitHub's late
// trigger actually starts. If the dispatcher already did this slot, the run exits quietly.
//
// That is what lets the dispatcher's grace period drop to ~0: it no longer has to guess.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULES, EACH OF WHICH IS LOad-BEARING
//
// 1. ONLY `schedule` events are gated. A dispatch — whether from the dispatcher or a human
//    pressing Run — always proceeds. An explicit instruction must never be silently swallowed.
// 2. FAIL OPEN. Any error, any doubt: run the agent. A duplicate is an annoyance; a suppressed
//    fleet is a disaster. (The workflow must also set `continue-on-error: true` on this step —
//    Actions otherwise skips later steps when a step fails, which is fail-CLOSED.)
// 3. A claim only counts once CONFIRMED. `--confirm` marks it after the agent succeeds. An
//    unconfirmed claim means the run failed, so the slot stays open and GitHub's retry proceeds.
// 4. Never skip in `observe` mode. It records what it WOULD have done, and runs the agent anyway.
//
// Outputs (to $GITHUB_OUTPUT):
//   skip=true|false        the gating decision
//   claimed=true|false     whether THIS run owns the slot (drives the confirm step)
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";
import { slotFor, slotKey, claimKey } from "../lib/slot.js";

const AGENT = process.env.GATE_AGENT || "";
const EVENT = process.env.GATE_EVENT || "";
const CRON = process.env.GATE_CRON || "";
const RUN_ID = process.env.GITHUB_RUN_ID || null;
const CONFIRM = process.argv.includes("--confirm");

const KV_TUNING = "dispatch:tuning";
const KV_ENABLED = "dispatch:enabled";

// How far back a dispatched run will look for a dispatcher claim to adopt. Deliberately short:
// long enough to cover a dispatch plus a slow runner boot, short enough that a human pressing Run
// cannot accidentally confirm a stale claim left by an earlier FAILED dispatcher run — which would
// mark a slot done that nobody actually completed.
const ADOPT_WINDOW_MIN = 15;

function output(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) { try { appendFileSync(f, `${name}=${value}\n`); } catch {} }
}
function summary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { appendFileSync(f, md + "\n"); } catch {} }
}
/** Every exit goes through here, so `skip` is never left unset. */
function done(skip, claimed, message) {
  output("skip", skip ? "true" : "false");
  output("claimed", claimed ? "true" : "false");
  console.log(message);
  process.exit(0);
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return done(false, false, "gate: no Supabase credentials — running (fail open)");
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const get = async (k) => (await db.from("kv").select("value").eq("key", k).maybeSingle()).data?.value;

  // The master switch. Off means the dispatcher, the gate and the nightly report are all inert,
  // and the fleet behaves precisely as it did before any of this was built.
  const enabled = await get(KV_ENABLED);
  if (!(enabled === true || enabled?.enabled === true)) {
    return done(false, false, "gate: dispatcher switched off — running (gate inert)");
  }

  const mode = (await get(KV_TUNING))?.gateMode || "off";
  if (mode === "off") return done(false, false, "gate: gateMode=off — running");

  // ── the confirm pass ────────────────────────────────────────────────────────────────────
  //
  // Two shapes, because the two triggers know different things.
  //
  // A SCHEDULED run knows its cron (GitHub supplies `github.event.schedule`), so it can compute
  // its own slot and confirm exactly that claim.
  //
  // A DISPATCHED run knows nothing — GitHub does not say which schedule a dispatch stands in for.
  // It therefore adopts the dispatcher's own claim: the most recent unconfirmed one for this
  // agent, made in the last few minutes.
  //
  // WHY THAT MATTERS. Without it, a dispatcher claim stays unconfirmed until the dispatcher's NEXT
  // cycle notices the run succeeded — up to 30 minutes. The gate refuses to skip on an unconfirmed
  // claim (an unconfirmed claim may mean the run failed), so for those 30 minutes GitHub's own
  // delivery would run the agent a second time. That window is the only reason `graceMin` cannot
  // drop below GitHub's normal lateness. Closing it here is what makes a low grace safe.
  const confirmRow = async (key, value) => {
    await db.from("kv").update({
      value: { ...(value || {}), ok: true, confirmed_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).eq("key", key);
  };

  if (CONFIRM) {
    if (EVENT === "schedule" && CRON) {
      const slot = slotFor(CRON, new Date());
      if (!slot) return done(false, false, "gate(confirm): no slot — nothing to confirm");
      const key = claimKey(AGENT, CRON, slot);
      const { data } = await db.from("kv").select("value").eq("key", key).maybeSingle();
      if (!data) return done(false, false, `gate(confirm): no claim at ${key}`);
      await confirmRow(key, data.value);
      return done(false, false, `gate(confirm): slot ${slotKey(slot)} confirmed done`);
    }

    // Dispatched run. Query by time rather than by a LIKE on the agent name — names contain
    // spaces, parentheses and a `·`, and one containing `%` or `_` would silently become a
    // wildcard. Filter for this agent in JS instead.
    const since = new Date(Date.now() - ADOPT_WINDOW_MIN * 60000).toISOString();
    const { data: rows } = await db.from("kv").select("key,value,updated_at")
      .like("key", "gate:%").gte("updated_at", since);

    const mine = (rows || [])
      .filter((r) => r.key.startsWith(`gate:${AGENT}:`))
      .filter((r) => r.value?.by === "dispatcher" && !r.value?.ok)
      .sort((a, b) => String(b.value?.at || "").localeCompare(String(a.value?.at || "")));

    if (!mine.length) {
      // A human pressing Run, or a dispatch the dispatcher did not make. Nothing to adopt, and
      // nothing should be invented — confirming a slot nobody claimed would let the gate skip a
      // run that was never covered.
      return done(false, false, "gate(confirm): no recent unconfirmed dispatcher claim — nothing to adopt");
    }

    await confirmRow(mine[0].key, mine[0].value);
    return done(false, false, `gate(confirm): adopted and confirmed ${mine[0].key.replace(/^gate:/, "")}`);
  }

  // ── rule 1: only schedule events are gated ──────────────────────────────────────────────
  if (EVENT !== "schedule") {
    return done(false, false, `gate: event=${EVENT || "?"} — not a schedule trigger, running`);
  }
  if (!CRON) {
    return done(false, false, "gate: schedule event with no cron string — running (fail open)");
  }

  const slot = slotFor(CRON, new Date());
  if (!slot) return done(false, false, `gate: could not resolve a slot for "${CRON}" — running (fail open)`);

  const key = claimKey(AGENT, CRON, slot);
  const nowIso = new Date().toISOString();

  // ── the atomic claim ────────────────────────────────────────────────────────────────────
  // Insert, don't upsert, and don't read-then-write: with the dispatcher's grace at ~0 the two can
  // fire seconds apart, and only a unique-key conflict is a real lock. kv.key is the primary key.
  const ins = await db.from("kv").insert({
    key,
    value: { by: "schedule", at: nowIso, run_id: RUN_ID },
    updated_at: nowIso,
  });

  if (!ins.error) {
    summary(`✅ **Gate:** claimed slot \`${slotKey(slot)}\` for \`${CRON}\` — running.`);
    return done(false, true, `gate: claimed slot ${slotKey(slot)} — running`);
  }

  if (ins.error.code !== "23505") {
    // Some other database problem. Never guess.
    return done(false, false, `gate: claim failed (${ins.error.code}) — running (fail open)`);
  }

  // ── someone already holds it — but only a CONFIRMED claim may stop us ───────────────────
  const { data: held } = await db.from("kv").select("value").eq("key", key).maybeSingle();
  const by = held?.value?.by === "dispatcher" ? "Dispatcher" : "a scheduled run";
  const at = held?.value?.at ? new Date(held.value.at).toISOString().slice(11, 16) : "?";

  if (!held?.value?.ok) {
    // Claimed but never confirmed: that run failed, was cancelled, or is still going. Letting this
    // one proceed risks a duplicate; blocking it risks the work never happening at all. Duplicate
    // is the better failure.
    summary(`⚠️ **Gate:** slot \`${slotKey(slot)}\` was claimed by ${by} at ${at} but never confirmed — running anyway.`);
    return done(false, false, `gate: unconfirmed claim by ${by} at ${at} — running (fail open)`);
  }

  const line = `Skipped — already ran by ${by} at ${at}`;

  // Record it for the nightly report. Without this the report can only infer skips from run
  // history, and an inference cannot tell "the gate stopped a duplicate" from "nothing was due".
  // Best-effort: never let bookkeeping change the gating decision.
  try {
    await db.from("kv").insert({
      key: `gateskip:${new Date().toISOString().slice(0, 10)}:${AGENT}:${slotKey(slot)}`,
      value: { agent: AGENT, cron: CRON, slot: slotKey(slot), by: held?.value?.by || "?", at: held?.value?.at, mode, run_id: RUN_ID },
      updated_at: new Date().toISOString(),
    });
  } catch { /* ignore */ }

  if (mode === "observe") {
    summary(`👁️ **Gate (observe):** would have skipped — already ran by ${by} at ${at}. Slot \`${slotKey(slot)}\`. Running anyway.`);
    return done(false, false, `gate(observe): WOULD SKIP — ${line}`);
  }

  summary(`⏭️ **${line}**\n\nSlot \`${slotKey(slot)}\` for \`${CRON}\`. This is not a failure — GitHub delivered a run the dispatcher had already covered.`);
  return done(true, false, `gate: ${line}`);
}

main().catch((e) => {
  // Rule 2, last line of defence.
  done(false, false, `gate: unexpected error (${e.message}) — running (fail open)`);
});
