// agents/inbox-router/commands.js
// Two-way command registry. Add a command = add one entry to COMMANDS below.
// Each handler receives the parsed args array and replies via Telegram.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { notifyTelegram, tgEscape } from "../../lib/notify.js";
import { generateNotes } from "../14-notes/generate.js";
import { addIdea, listIdeas } from "../18-ideas/ideas.js";

// Lazy DB so importing this module (e.g. to read command metadata) needs no Supabase env.
let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

function windowDays(args, fallback = 7) {
  const s = args.join(" ").toLowerCase();
  if (s.includes("today")) return 1;
  if (s.includes("week")) return 7;
  if (s.includes("fortnight")) return 14;
  if (s.includes("month")) return 30;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const sinceDate = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

async function journal(args) {
  const days = windowDays(args);
  const { data } = await db().from("journal").select("*").gte("entry_date", sinceDate(days)).order("entry_date", { ascending: false });
  if (!data?.length) return notifyTelegram(`🌙 <b>Journal</b>\nNo entries in the last ${days} day(s).`, { html: true });
  const body = data.map((e) => `📅 <b>${tgEscape(e.entry_date)}</b> · <i>${tgEscape(e.mood || "")}</i>\n${tgEscape(e.summary || e.raw || "")}`).join("\n\n");
  return notifyTelegram(`🌙 <b>Journal — last ${days} day(s)</b>\n\n${body}`, { html: true });
}

async function reading() {
  const { data } = await db().from("reading").select("*").eq("read", false).order("created_at", { ascending: false }).limit(15);
  if (!data?.length) return notifyTelegram(`📚 <b>Reading queue</b>\nNothing unread. 🎉`, { html: true });
  const body = data.map((r) => `• <b>${tgEscape(r.title || r.url)}</b>${r.tags?.length ? ` <i>[${tgEscape(r.tags.join(", "))}]</i>` : ""}`).join("\n");
  const buttons = data.slice(0, 6).map((r) => [{ text: `📖 ${(r.title || "link").slice(0, 28)}`, url: r.url }]);
  return notifyTelegram(`📚 <b>Unread — ${data.length}</b>\n\n${body}`, { html: true, buttons });
}

async function expenses(args) {
  const days = windowDays(args);
  const { data } = await db().from("expenses").select("*").gte("spent_on", sinceDate(days));
  if (!data?.length) return notifyTelegram(`💸 <b>Expenses</b>\nNothing logged in the last ${days} day(s).`, { html: true });
  const byCat = {}; let total = 0;
  for (const e of data) { const a = Number(e.amount) || 0; const c = e.category || "other"; byCat[c] = (byCat[c] || 0) + a; total += a; }
  const cur = data[0].currency || "INR";
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `  ${tgEscape(c)}: ${cur} ${Math.round(v).toLocaleString("en-IN")}`).join("\n");
  return notifyTelegram(`💸 <b>Spend — last ${days} day(s)</b>\nTotal: <b>${cur} ${Math.round(total).toLocaleString("en-IN")}</b> · ${data.length} txns\n\n${cats}`, { html: true });
}

async function habits(args) {
  const days = windowDays(args, 14);
  const { data } = await db().from("habits").select("*").gte("log_date", sinceDate(days)).order("log_date", { ascending: false });
  if (!data?.length) return notifyTelegram(`📊 <b>Habits</b>\nNo logs in the last ${days} day(s).`, { html: true });
  const body = data.map((h) => `📅 <b>${tgEscape(h.log_date)}</b> · 😴 ${tgEscape(h.sleep_time || "?")}–${tgEscape(h.wake_time || "?")} · ⚡ ${h.productivity ?? "?"}/5${h.exercised ? " · 🏋️" : ""}`).join("\n");
  return notifyTelegram(`📊 <b>Habits — last ${days} day(s)</b>\n\n${body}`, { html: true });
}

async function notes(args) {
  const url = args[0];
  if (!url || !/^https?:\/\//.test(url)) return notifyTelegram(`📝 Usage: <code>/notes https://…</code>`, { html: true });
  await notifyTelegram(`📝 Working on notes for that link… (~20s)`, { html: true });
  const text = await generateNotes(url);
  for (const chunk of text.match(/[\s\S]{1,3800}/g) || [text]) {
    await notifyTelegram(tgEscape(chunk), { html: true });
  }
}

async function idea(args) {
  const text = args.join(" ").trim();
  if (!text) return notifyTelegram(`💡 Usage: <code>/idea your one-line idea</code>`, { html: true });
  await notifyTelegram(`💡 Spec'ing that idea… (~15s)`, { html: true });
  const r = await addIdea(text);
  const prompt = r.prompt ? `\n\n<b>Claude Code prompt:</b>\n<code>${tgEscape(r.prompt)}</code>` : "";
  return notifyTelegram(`💡 <b>${tgEscape(r.title)}</b> saved · score ${r.score}${prompt}`, { html: true });
}

async function ideas() {
  const list = await listIdeas(15);
  if (!list.length) return notifyTelegram(`💡 <b>Backlog</b>\nEmpty. Add one with /idea &lt;text&gt;`, { html: true });
  const body = list.map((i) => `[${i.score}] <b>${tgEscape(i.title)}</b> — ${tgEscape(i.spec?.problem || "")}`).join("\n");
  return notifyTelegram(`💡 <b>Idea backlog</b>\n\n${body}`, { html: true });
}

export const COMMANDS = {
  journal:  { description: "Recent journal entries (e.g. /journal last week)", handler: journal },
  reading:  { description: "Your unread saved links", handler: reading },
  expenses: { description: "Spend summary (e.g. /expenses month)", handler: expenses },
  habits:   { description: "Recent habit logs (e.g. /habits 14)", handler: habits },
  notes:    { description: "Notes from a video/article: /notes <url>", handler: notes },
  idea:     { description: "Save + spec a new idea: /idea <one-liner>", handler: idea },
  ideas:    { description: "Your ranked idea backlog", handler: ideas },
};

export async function runCommand(text) {
  const parts = text.trim().slice(1).split(/\s+/); // drop leading "/"
  const name = (parts[0] || "").toLowerCase();
  const args = parts.slice(1);
  const cmd = COMMANDS[name];
  if (!cmd) {
    const list = Object.entries(COMMANDS).map(([n, c]) => `/${n} — ${c.description}`).join("\n");
    return notifyTelegram(`🤖 <b>Commands</b>\n\n${tgEscape(list)}`, { html: true });
  }
  return cmd.handler(args);
}
