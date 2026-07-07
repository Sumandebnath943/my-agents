// evals/run-all.mjs
// Runs every eval suite, aggregates, and exits non-zero if anything failed (CI gate).
// Offline: no secrets, no network. Run: `npm run eval:all`.
import "./_env.mjs";
import { run as routing } from "./routing/run.mjs";
import { run as json } from "./json/run.mjs";
import { run as linkedin } from "./linkedin/run.mjs";
import { run as critique } from "./critique/run.mjs";

const suites = [routing, json, linkedin, critique];

let totalPass = 0, totalFail = 0;
const allFails = [];
for (const run of suites) {
  for (const res of await run()) { // await handles both sync and async suites
    totalPass += res.pass;
    totalFail += res.fail;
    for (const f of res.fails) allFails.push(`${res.label} :: ${f.id} — ${f.note}`);
  }
}

console.log("\n" + "=".repeat(50));
console.log(`TOTAL ${totalPass}/${totalPass + totalFail} passed` + (totalFail ? ` — ${totalFail} FAILED` : " — all green"));
if (totalFail) {
  console.log("\nFailures:");
  for (const f of allFails) console.log("  " + f);
  process.exit(1);
}
