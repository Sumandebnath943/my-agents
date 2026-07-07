// evals/routing/run.mjs
// Guards the inbox router's DECISION logic (which handler an inbound message goes to) plus the
// windowDays() parser and the /command registry. Pure + offline — no DB, no LLM, no network.
import "../_env.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCases, isMain } from "../_lib.mjs";
import { classifyRoute } from "../../agents/inbox-router/route.js";
import { windowDays, COMMANDS } from "../../agents/inbox-router/commands.js";

const here = dirname(fileURLToPath(import.meta.url));

export function run() {
  const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));

  const routing = runCases("routing · message → handler", corpus, (c) => {
    const got = classifyRoute(c.msg);
    return { ok: got === c.expect, note: got === c.expect ? "" : `got "${got}", expected "${c.expect}"` };
  });

  // windowDays(args, fallback=7): parse a time window from command args.
  const windows = [
    { id: "today->1",         args: ["today"],       expect: 1 },
    { id: "week->7",          args: ["last", "week"], expect: 7 },
    { id: "fortnight->14",    args: ["fortnight"],   expect: 14 },
    { id: "month->30",        args: ["month"],       expect: 30 },
    { id: "numeric->5",       args: ["5"],           expect: 5 },
    { id: "empty->fallback7", args: [],              expect: 7 },
    { id: "garbage->fallback7", args: ["banana"],    expect: 7 },
  ];
  const windowsRes = runCases("routing · windowDays()", windows, (c) => {
    const got = windowDays(c.args);
    return { ok: got === c.expect, note: got === c.expect ? "" : `got ${got}, expected ${c.expect}` };
  });

  // The documented Telegram commands must stay registered.
  const expectedCmds = ["journal", "reading", "expenses", "habits", "notes", "idea", "ideas", "drafts"];
  const registry = runCases("routing · /command registry", expectedCmds.map((n) => ({ id: `/${n}`, name: n })), (c) => {
    const cmd = COMMANDS[c.name];
    return { ok: !!(cmd && typeof cmd.handler === "function"), note: cmd ? "" : "not registered" };
  });

  return [routing, windowsRes, registry];
}

if (isMain(import.meta.url)) {
  const results = run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
