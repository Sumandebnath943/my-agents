// agents/inbox-router/index.js
// ONE poller for every Telegram-input agent (#13 links, #15 journal, #16 receipts,
// #17 habits). Telegram's getUpdates offset is GLOBAL — separate pollers would
// acknowledge (and purge) each other's messages — so we poll once here and route
// each message to the right handler by type.
import { getNewMessages } from "../../lib/telegram-poll.js";
import { handleReadLater } from "../13-readlater/handle.js";
import { handleExpense } from "../16-expenses/handle.js";
import { handleHabit, isHabitLog } from "../17-habits/handle.js";
import { handleJournal } from "../15-journal/handle.js";

const messages = await getNewMessages();
if (!messages.length) { console.log("No new messages."); process.exit(0); }

for (const msg of messages) {
  try {
    if (msg.photoFileId) {
      await handleExpense(msg);                    // receipt photo -> expense
      console.log("routed: expense");
    } else if (msg.text.trim().startsWith("/")) {
      // RESERVED for the future two-way command agent (e.g. "/spend this week").
      // Kept out of the journal so commands never become reflections.
      // TODO: dispatch to a command handler once the two-way bot is built.
      console.log("routed: command (stub, ignored):", msg.text.slice(0, 60));
    } else if (/https?:\/\//.test(msg.text)) {
      const n = await handleReadLater(msg);        // link(s) -> reading queue
      console.log(`routed: readlater (${n} saved)`);
    } else if (isHabitLog(msg.text)) {
      await handleHabit(msg);                       // "slept 2 woke 9..." -> habits
      console.log("routed: habit");
    } else if (msg.text && msg.text.length >= 10) {
      await handleJournal(msg);                     // freeform reply -> journal
      console.log("routed: journal");
    } else {
      console.log("skipped (too short):", msg.text?.slice(0, 40));
    }
  } catch (e) {
    console.error(`handler failed for update ${msg.updateId}:`, e.message);
  }
}
