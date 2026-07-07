// evals/memory/run.mjs
// Guards the memory layer's pure math (cosine) and its best-effort contract: with no embed/DB
// available, remember()/recall() degrade quietly (skip / empty) rather than throwing. Offline.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { cosine, remember, recall } from "../../lib/memory.js";

export async function run() {
  const cos = runCases("memory · cosine()", [
    { id: "identical=1", ok: Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9 },
    { id: "orthogonal=0", ok: Math.abs(cosine([1, 0], [0, 1])) < 1e-9 },
    { id: "opposite=-1", ok: Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9 },
    { id: "mismatched-len=0", ok: cosine([1, 2], [1, 2, 3]) === 0 },
    { id: "empty=0", ok: cosine(null, [1]) === 0 },
  ], (c) => ({ ok: c.ok }));

  // Force offline: no embedding/DB creds → embed() throws → best-effort fallbacks kick in.
  for (const k of ["GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY"]) delete process.env[k];
  const saved = await remember("Suman prefers concise LinkedIn hooks", { scope: "user" });
  const got = await recall("linkedin voice", { scope: "user" });

  const contract = runCases("memory · best-effort fallback", [
    { id: "remember-skips-when-offline", ok: saved && saved.action === "skip" },
    { id: "recall-empty-when-offline", ok: Array.isArray(got) && got.length === 0 },
  ], (c) => ({ ok: c.ok }));

  return [cos, contract];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
