// agents/inbox-router/from-webhook.js
// Processes ONE Telegram update passed in via the webhook (env TG_UPDATE = raw update JSON).
// Reuses the exact same handlers as the polling router — no duplication.
import { handleReadLater } from "../13-readlater/handle.js";
import { handleExpense } from "../16-expenses/handle.js";
import { handleHabit } from "../17-habits/handle.js";
import { handleJournal } from "../15-journal/handle.js";
import { runCommand } from "./commands.js";
import { classifyRoute } from "./route.js";

const raw = process.env.TG_UPDATE;
if (!raw) { console.log("No TG_UPDATE."); process.exit(0); }

let update;
try { update = JSON.parse(raw); } catch { console.error("Bad TG_UPDATE JSON."); process.exit(1); }

const m = update.message;
if (!m) { console.log("No message in update (nothing to do)."); process.exit(0); }

const msg = {
  updateId: update.update_id,
  text: m.text || m.caption || "",
  photoFileId: m.photo ? m.photo[m.photo.length - 1].file_id : null, // largest size
  date: m.date,
};

try {
  switch (classifyRoute(msg)) {
    case "expense":   await handleExpense(msg); console.log("routed: expense"); break;
    case "command":   await runCommand(msg.text); console.log("routed: command", msg.text.slice(0, 40)); break;
    case "readlater": console.log(`routed: readlater (${await handleReadLater(msg)})`); break;
    case "habit":     await handleHabit(msg); console.log("routed: habit"); break;
    case "journal":   await handleJournal(msg); console.log("routed: journal"); break;
    default:          console.log("skipped:", msg.text?.slice(0, 40));
  }
} catch (e) {
  console.error("handler failed:", e.message);
}
