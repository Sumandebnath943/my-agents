// evals/_lib.mjs
// Tiny shared harness — mirrors the reporting style of the dashboard's scripts/finance-eval.mjs.
// Each eval calls runCases(label, cases, check). `check(case)` returns { ok, note? }.
// A note ending in "(warn)" is informational and does NOT fail the case.

/**
 * @param {string} label
 * @param {Array<object>} cases        each should carry an `id`
 * @param {(c: object) => {ok: boolean, note?: string}} check
 * @returns {{label: string, pass: number, fail: number, fails: Array<{id:string, note:string}>}}
 */
export function runCases(label, cases, check) {
  let pass = 0, fail = 0;
  const fails = [];
  console.log(`\n▶ ${label}`);
  for (const c of cases) {
    let ok = false, note = "";
    try {
      const r = check(c) || {};
      ok = !!r.ok;
      note = r.note || "";
    } catch (e) {
      ok = false;
      note = `threw: ${e.message}`;
    }
    const hardFail = !ok;
    if (hardFail) { fail++; fails.push({ id: c.id, note }); } else pass++;
    const mark = hardFail ? "✗" : "✓";
    const detail = note ? `  (${note})` : "";
    console.log(`  ${mark} ${String(c.id).padEnd(30)}${detail}`);
  }
  console.log(`  ${pass}/${pass + fail} passed` + (fail ? ` — ${fail} FAILED` : " — all green"));
  return { label, pass, fail, fails };
}

// True when a module file is being executed directly (node evals/x/run.mjs), false when imported.
import { pathToFileURL } from "node:url";
export function isMain(importMetaUrl) {
  return !!process.argv[1] && importMetaUrl === pathToFileURL(process.argv[1]).href;
}
