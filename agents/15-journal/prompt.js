// agents/15-journal/prompt.js — evening check-in nudge.
import { notifyTelegram } from "../../lib/notify.js";
const prompts = [
  "What went well today, and what drained you?",
  "One thing you learned or realized:",
  "How are you feeling right now, in a word or two?",
];
await notifyTelegram(`🌙 *Evening check-in*\n\n${prompts.join("\n")}\n\n_Just reply in one message whenever._`);
