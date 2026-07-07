// evals/critique/run.mjs
// Guards the critique() safety contract: it must NEVER block or alter the primary output on failure.
// We force the failure path offline by removing all provider keys — callPrivate then throws and
// critique must return the original text with ok:true. No network.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { critique } from "../../lib/critique.js";

export async function run() {
  // Force offline: with no provider keys, callPrivate throws → critique falls back to the original.
  for (const k of ["GROQ_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[k];

  const original = "Shipped the free-tier pacing fix today.";
  const empty = await critique("", { criteria: "anything" });
  const failed = await critique(original, { role: "reviewer", criteria: "must be great" });

  const cases = [
    { id: "empty-input-passthrough", ok: empty.text === "" && empty.ok === true },
    { id: "llm-fail-returns-original", ok: failed.text === original && failed.ok === true },
    { id: "llm-fail-records-error", ok: typeof failed.error === "string" && failed.error.length > 0 },
    { id: "shape-issues-array", ok: Array.isArray(failed.issues) },
  ];

  return [runCases("critique · best-effort fallback", cases, (c) => ({ ok: c.ok }))];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
