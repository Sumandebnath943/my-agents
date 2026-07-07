// evals/json/run.mjs
// Guards parseJson() — the fence-stripping used across agents to recover JSON from LLM output.
// If someone breaks the ``` cleanup, this catches it. Pure + offline.
import { runCases, isMain } from "../_lib.mjs";
import { parseJson } from "../../lib/llm.js";

export function run() {
  const cases = [
    { id: "fenced-json-tag",   in: "```json\n{\"a\":1}\n```",      expect: { a: 1 } },
    { id: "fenced-plain",      in: "```\n{\"c\":3}\n```",           expect: { c: 3 } },
    { id: "bare-object",       in: "{\"b\":2}",                     expect: { b: 2 } },
    { id: "surrounding-space", in: "   {\"d\":4}   ",               expect: { d: 4 } },
    { id: "nested",            in: "```json\n{\"x\":{\"y\":[1,2]}}\n```", expect: { x: { y: [1, 2] } } },
    { id: "non-json-throws",   in: "sorry, I can't do that",        throws: true },
  ];

  return [runCases("json · parseJson()", cases, (c) => {
    if (c.throws) {
      try { parseJson(c.in); return { ok: false, note: "expected a throw, got a value" }; }
      catch { return { ok: true }; }
    }
    const got = parseJson(c.in);
    const same = JSON.stringify(got) === JSON.stringify(c.expect);
    return { ok: same, note: same ? "" : `got ${JSON.stringify(got)}` };
  })];
}

if (isMain(import.meta.url)) {
  const results = run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
