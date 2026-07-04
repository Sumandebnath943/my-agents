// scripts/cto-review.js
// Standalone, portable code reviewer — no lib/ imports so it can be dropped into ANY
// repo. Reviews the push diff with Groq and writes a commit-comment markdown file.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let diff = "";
try {
  const before = process.env.GITHUB_EVENT_BEFORE;
  const base = before && !/^0+$/.test(before) ? before : "HEAD~1";
  diff = execSync(`git diff ${base} HEAD -- . ':(exclude)package-lock.json'`, { encoding: "utf8" });
} catch { diff = execSync("git show HEAD", { encoding: "utf8" }); }
diff = diff.slice(0, 20000);
if (!diff.trim()) { console.log("No diff."); process.exit(0); }

const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "openai/gpt-oss-120b",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You are a senior staff engineer reviewing a git diff. Return JSON:
{"verdict":"approve|comment|request_changes","summary":"1-2 lines","issues":[{"severity":"high|med|low","category":"security|performance|quality|duplication|docs|tests","note":"specific+actionable","where":"file/line hint"}]}.
Flag real problems only: leaked secrets, injection, obvious perf issues, duplicated logic, missing error handling, undocumented public functions, code changed with no matching test. Skip nitpicks.` },
      { role: "user", content: diff },
    ],
  }),
});
const review = JSON.parse((await res.json()).choices[0].message.content);
const body = [
  `### 🤖 CTO review — ${review.verdict.toUpperCase()}`, review.summary, "",
  ...review.issues.map((i) => `- **[${i.severity}/${i.category}]** ${i.note}${i.where ? ` _(${i.where})_` : ""}`),
  review.issues.length ? "" : "_No issues found._",
].join("\n");
writeFileSync("review-comment.md", body);
writeFileSync(process.env.GITHUB_STEP_SUMMARY || "summary.md", body);
console.log(body);
