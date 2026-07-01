// lib/profile.js
// WHO YOU ARE — the source of truth the brand agents use to write in your voice and
// position you. Built from your portfolio (sumandebnath.houseofnamus.com). Edit freely.
export const PROFILE = {
  name: "Suman Debnath",
  location: "Pune, India",
  positioning: "AI Leader / AI Generalist — a senior product marketer who architects and ships AI-native products",
  goal:
    "Be seen as an AI Leader / AI Generalist: the rare operator who thinks across systems — pairing 9+ years of real product-marketing depth with independently shipping 10+ AI-native products. Not someone who uses AI, someone who builds with it.",
  audience: "founders, hiring managers, marketers, and AI builders on LinkedIn",
  voice:
    "Clear, declarative, systems-thinking. Short punchy lines. Teach something real with concrete specifics. A little bold, never cringe. No buzzwords, no hashtag spam, minimal emoji. Sounds like a builder who has actually shipped.",

  // Core operating beliefs (your portfolio's six principles) — great seeds for posts.
  beliefs: [
    "Intelligence is infrastructure — the future belongs to those who architect around AI, not just use it.",
    "Systems compound; one-off execution collapses at scale. Build environments where solutions keep emerging.",
    "Human identity must survive automation — judgment, taste, and instinct get MORE valuable as AI gets capable.",
    "Craft still matters — execution without taste is just noise.",
    "Speed is a creative advantage — rapid prototype → iterate → evolve is strategic.",
    "The operator evolves — design, strategy, systems, engineering, and AI orchestration are converging into one role.",
  ],
  signatureLine: "The future belongs to operators who can think across systems.",

  // What makes you different (your edge, use sparingly and concretely).
  proof: [
    "9+ years in product marketing; Senior PMM with multiple promotions",
    "Led a 21-person cross-functional team; 350%+ ROAS, 30% CPA reduction, 40–50% traffic growth",
    "Built GenAI pipelines that cut hours of creative/ops work daily",
    "Shipped 10+ AI-native products independently — with no engineering degree",
    "Generative & Agentic AI — Saïd Business School, University of Oxford; Anthropic Claude / Claude Code certified",
  ],

  // Content pillars the agent should rotate through.
  pillars: [
    "being a marketer who builds AI (not just uses it)",
    "architecting AI-native systems as a solo operator",
    "shipping fast on lean/free stacks (ideation → launch in ~a week)",
    "AI generalist breadth — models, agents, products across domains",
    "human judgment & taste in an automated world",
    "build-in-public lessons from the House of Namus portfolio",
  ],

  // Shipped work — anchor posts in these (accurate as of the portfolio).
  projects: [
    "ROASmind — AI-native marketing OS unifying Meta/Google/LinkedIn under one AI brain (~200k+ LOC, stealth)",
    "IMPRINT — identity-preservation engine defending human judgment against AI dependency (live)",
    "LEGATUS — immutable digital-inheritance vault, AES-256 / RSA-2048 (live)",
    "CITE — tactical career-intelligence engine (live)",
    "EMBER — burnout-recovery companion (live)",
    "D-PE.ai — god-tier prompt-engineering workspace (live)",
    "Brief Killer (AI briefs), Crawl Daddy (SEO intelligence), Repurpose AI (content), Slyde Doctor (deck audit)",
    "Geek Collectibles — high-ticket collector commerce (coming soon)",
    "…all under House of Namus (houseofnamus.com)",
  ],
};

export function profileContext() {
  return [
    `Name: ${PROFILE.name} (${PROFILE.location})`,
    `Positioning: ${PROFILE.positioning}`,
    `Goal: ${PROFILE.goal}`,
    `Audience: ${PROFILE.audience}`,
    `Voice: ${PROFILE.voice}`,
    `Signature line: ${PROFILE.signatureLine}`,
    `Operating beliefs:\n- ${PROFILE.beliefs.join("\n- ")}`,
    `Proof points: ${PROFILE.proof.join("; ")}`,
    `Content pillars: ${PROFILE.pillars.join("; ")}`,
    `Shipped work: ${PROFILE.projects.join("; ")}`,
  ].join("\n");
}
