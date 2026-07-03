// agents/inbox-router/register-commands.js
// Registers the command list with Telegram so typing "/" shows an autocomplete menu.
// Run once (and again whenever you add/rename commands) via the "Register Bot Commands" workflow.
import { env } from "../../lib/env.js";
import { COMMANDS } from "./commands.js";

const commands = Object.entries(COMMANDS).map(([command, c]) => ({
  command,
  description: c.description.slice(0, 256),
}));
// On-demand agent triggers (handled by the webhook).
commands.push(
  { command: "briefing", description: "Run the Daily Tech Briefing now" },
  { command: "video", description: "Run the Evening Video Digest now" },
  { command: "standup", description: "Run the Morning Standup now" },
  { command: "deps", description: "Run the Dependency Digest now" },
  { command: "uptime", description: "Run an uptime check now" },
  { command: "expiry", description: "Run the Expiry Watcher now" },
  { command: "review", description: "Run the Weekly Founder Review now" },
  { command: "linkedin", description: "Generate a LinkedIn draft now" },
);
commands.push({ command: "spend", description: "Show recent spend by category" });
commands.push({ command: "help", description: "List all commands" });

const res = await fetch(
  `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/setMyCommands`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commands }) }
);
console.log("setMyCommands:", res.status, await res.text());
