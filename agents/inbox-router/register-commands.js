// agents/inbox-router/register-commands.js
// Registers the command list with Telegram so typing "/" shows an autocomplete menu.
// Run once (and again whenever you add/rename commands) via the "Register Bot Commands" workflow.
import { env } from "../../lib/env.js";
import { COMMANDS } from "./commands.js";

const commands = Object.entries(COMMANDS).map(([command, c]) => ({
  command,
  description: c.description.slice(0, 256),
}));
commands.push({ command: "help", description: "List all commands" });

const res = await fetch(
  `https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/setMyCommands`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commands }) }
);
console.log("setMyCommands:", res.status, await res.text());
