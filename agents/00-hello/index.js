// agents/00-hello/index.js
import { callGroq } from "../../lib/llm.js";
import { notifyTelegram } from "../../lib/notify.js";

const joke = await callGroq([
  { role: "system", content: "You are concise." },
  { role: "user", content: "Give me one short motivational line for a builder." },
]);

await notifyTelegram(`🤖 *Hello from your agent system!*\n\n${joke}`);
console.log("Sent:", joke);
