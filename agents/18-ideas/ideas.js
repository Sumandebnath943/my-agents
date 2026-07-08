// agents/18-ideas/ideas.js
// Shared idea-backlog logic (used by the CLI and the /idea, /ideas Telegram commands).
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM, parseJson } from "../../lib/llm.js";

let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

// Constrain the spec shape so scoring (impact*feasibility) and the stored `spec` JSON are always
// well-formed — the model can't drop a field or return ratings as strings.
const IDEA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "short name" },
    spec: {
      type: "object",
      properties: {
        problem: { type: "string" },
        users: { type: "string" },
        core_features: { type: "array", items: { type: "string" } },
        free_stack: { type: "array", items: { type: "string" }, description: "tools that are free, no self-host" },
        claude_code_prompt: { type: "string", description: "a copy-paste prompt to start building it" },
      },
      required: ["problem", "users", "core_features", "free_stack", "claude_code_prompt"],
    },
    impact: { type: "integer", description: "1-5" },
    feasibility: { type: "integer", description: "1-5" },
  },
  required: ["title", "spec", "impact", "feasibility"],
};

export async function addIdea(idea) {
  const out = await callLLM(
    `Expand this app/agent idea into a tight spec. Idea: ${idea}`,
    { schema: IDEA_SCHEMA, chain: "public" } // /idea runs under the webhook (AGENT_NAME=migi)
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
