// lib/profile.js
// WHO YOU ARE — this is how the brand agents write in your voice and position you.
// Edit freely; the more accurate this is, the better the drafts. (Correct the project
// one-liners especially — the agents anchor posts in these.)
export const PROFILE = {
  name: "Suman Debnath",
  positioning: "AI Leader / AI Generalist",
  goal:
    "Be seen as an AI Leader / AI Generalist — someone who can conceive, build, and ship AI systems across the whole stack, fast.",
  audience: "founders, developers, and AI-curious professionals on LinkedIn",
  voice:
    "Clear, specific, a little informal. Teach something real with concrete examples. No buzzwords, no hashtag spam, minimal emoji. Confident, not cringe.",
  pillars: [
    "building AI agents and tools as a solo dev",
    "shipping fast on free tiers / lean stacks",
    "being an AI generalist — breadth across models, agents, and apps",
    "practical AI that automates real workflows",
    "lessons from shipping many products under one brand (House of Namus)",
  ],
  // Your shipped work — used to anchor posts in reality. EDIT these one-liners to be accurate.
  projects: [
    "Qdex — a small language model (1.5B)",
    "Pentashell / PentaCMD — AI-powered security / command tooling",
    "PACT — an AI agent",
    "Crawl Daddy — AI web crawler",
    "Repurpose AI — content repurposing",
    "ROASmind — AI for marketing / ad performance",
    "Brief Killer — turn briefs into work fast",
    "CITE — a research / citation engine",
    "Soul Canvas — creative AI",
    "Forget Anything — a personal memory app",
    "…and more under House of Namus (houseofnamus.com)",
  ],
};

export function profileContext() {
  return [
    `Name: ${PROFILE.name}`,
    `Positioning goal: ${PROFILE.goal}`,
    `Audience: ${PROFILE.audience}`,
    `Voice: ${PROFILE.voice}`,
    `Content pillars: ${PROFILE.pillars.join("; ")}`,
    `Things I've built: ${PROFILE.projects.join("; ")}`,
  ].join("\n");
}
