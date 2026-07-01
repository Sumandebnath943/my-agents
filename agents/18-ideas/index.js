// agents/18-ideas/index.js
// CLI (local use). Day-to-day you'll use the /idea and /ideas Telegram commands instead.
// Usage:
//   node agents/18-ideas/index.js add "an agent that drafts cold emails from a CSV"
//   node agents/18-ideas/index.js list
import { addIdea, listIdeas } from "./ideas.js";

const [, , cmd, ...rest] = process.argv;

if (cmd === "add") {
  const r = await addIdea(rest.join(" "));
  console.log(`Saved "${r.title}" (score ${r.score}).\n\nClaude Code prompt:\n${r.prompt}`);
} else if (cmd === "list") {
  for (const i of await listIdeas()) console.log(`[${i.score}] ${i.title} — ${i.spec?.problem || ""}`);
} else {
  console.log('Usage: node index.js add "your idea"  |  node index.js list');
}
