// agents/18-ideas/ideas.js
// Shared idea-backlog logic (used by the CLI and the /idea, /ideas Telegram commands).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGemini, parseJson } from "../../lib/llm.js";

let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

export async function addIdea(idea) {
  const out = await callGemini(
    `Expand this app/agent idea into a tight spec. Return ONLY JSON:
{"title":"short name","spec":{"problem":"","users":"","core_features":["",""],"free_stack":["tools that are free, no self-host"],"claude_code_prompt":"a copy-paste prompt to start building it"},"impact":1-5,"feasibility":1-5}.
Idea: ${idea}`,
    { json: true }
  );
  const o = parseJson(out);
  const score = (o.impact || 3) * (o.feasibility || 3);
  await db().from("ideas").insert({ title: o.title, spec: o.spec, impact: o.impact, feasibility: o.feasibility, score });
  return { title: o.title, score, prompt: o.spec?.claude_code_prompt || "", spec: o.spec };
}

export async function listIdeas(limit = 20) {
  const { data } = await db().from("ideas").select("*").order("score", { ascending: false }).limit(limit);
  return data || [];
}
