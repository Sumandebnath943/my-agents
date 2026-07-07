// agents/inbox-router/route.js
// The inbox routing DECISION, extracted as a pure function so it can be unit-eval'd offline
// (no DB, no network) and can't silently drift from what the webhook actually does.
// from-webhook.js calls this to pick a route, then dispatches to the matching handler.
import { isHabitLog } from "../17-habits/handle.js";

/**
 * Decide how ONE inbound Telegram message should be routed.
 * @param {{text?: string, photoFileId?: string|null}} msg
 * @returns {"expense"|"command"|"readlater"|"habit"|"journal"|"skip"}
 */
export function classifyRoute({ text = "", photoFileId = null } = {}) {
  if (photoFileId) return "expense";                      // a photo = a receipt/expense screenshot
  if (text.trim().startsWith("/")) return "command";      // slash command
  if (/https?:\/\//.test(text)) return "readlater";       // a link = save for later
  if (isHabitLog(text)) return "habit";                   // strict habit triggers (slept/woke/productivity)
  if (text && text.length >= 10) return "journal";        // enough prose = a journal entry
  return "skip";                                          // too short / nothing to do
}
