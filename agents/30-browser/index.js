// agents/30-browser/index.js — Web Watch. A watchlist-driven browser agent: for each target it
// loads the page in a headless browser, screenshots it, and asks Gemini vision the target's
// question (e.g. "what's the price?", "is my application still 'under review'?"). When the answer
// CHANGES from last run, it Telegrams you. Draft/alert only — it never fills forms or clicks buy.
//
// PUBLIC PAGES / your-own-login portals only (never LinkedIn or anything ToS-hostile to automation).
// The watchlist lives in kv `browser:watchlist` = [{ id, url, question }]; empty = nothing to do,
// so this agent is dormant until YOU add targets (via the MCP kv_set tool or the dashboard).
import { chromium } from "playwright";
import { getState, setState } from "../../lib/store.js";
import { callLLM } from "../../lib/llm.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { isUrlSafe } from "../../lib/scrape.js";

const watchlist = (await getState("browser:watchlist", [])) || [];
if (!watchlist.length) { console.log("browser: watchlist empty — nothing to watch."); process.exit(0); }

const browser = await chromium.launch();
let changes = 0;
try {
  for (const target of watchlist.slice(0, 10)) {
    const { id, url, question } = target || {};
    if (!id || !url) continue;
    // Authoritative SSRF check (DNS-resolving) immediately before we navigate. The dashboard
    // validates structurally when a target is saved, but a hostname's DNS can change afterwards —
    // this is the guard that actually protects the runner.
    if (!(await isUrlSafe(url))) { console.error(`browser: target ${id} skipped — unsafe or unresolvable URL.`); continue; }
    try {
      const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; MigiWebWatch/1.0)" });
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      const base64 = (await page.screenshot({ fullPage: false })).toString("base64");
      await page.close();

      const answer = (await callLLM(
        `This is a screenshot of ${url}. ${question || "Summarize the key state of this page"}. Reply with ONLY the short answer/value, no preamble.`,
        { images: [{ mimeType: "image/png", base64 }] } // images → vision chain (Gemini → GPT-4o)
      )).trim().slice(0, 300);

      const prev = await getState(`browser:last:${id}`, null);
      if (prev !== null && prev !== answer) {
        await notifyTelegram(
          `👁️ <b>Web Watch — change detected</b>\n<i>${tgEscape(id)}</i>\n\nWas: ${tgEscape(prev)}\nNow: <b>${tgEscape(answer)}</b>\n\n<a href="${url}">Open page →</a>`,
          { html: true }
        );
        changes++;
      }
      await setState(`browser:last:${id}`, answer);
      console.log(`watched ${id}: ${answer}`);
    } catch (e) {
      console.error(`browser: target ${id} failed:`, e.message); // one bad target never stops the rest
    }
  }
} finally {
  await browser.close();
}
console.log(`Web Watch done — ${changes} change(s) alerted across ${watchlist.length} target(s).`);
