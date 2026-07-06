// lib/hashtags.js — clean, relevant hashtags. Primary: an LLM generates proper tags in strict
// JSON (reliable, no filler). A hard filter rejects junk (verbs/stopwords like "was"). Fallback:
// a curated evergreen AI set. It NEVER derives tags from raw headline words (that produced #Was).
import { callGroq, parseJson } from "./llm.js";

const EVERGREEN = ["#AI", "#GenAI", "#AIAgents", "#LLM", "#MachineLearning", "#Automation", "#FutureOfWork", "#ProductMarketing", "#Innovation", "#BuildInPublic"];
const BAD = new Set("was were has had have will would could should did does the a an and or but not new news top best more most this that these those it is are am be been being to of in on at for with your you our their his her its as by from about into over your".split(" "));

function clean(tags) {
  const seen = new Set(); const out = [];
  for (const t of tags || []) {
    const bare = String(t).replace(/^#+/, "").replace(/[^A-Za-z0-9]/g, "");
    const k = bare.toLowerCase();
    if (bare.length < 3 || bare.length > 30) continue;
    if (BAD.has(k) || seen.has(k)) continue;
    seen.add(k); out.push("#" + bare);
  }
  return out;
}

async function llmTags(topic, platform, count) {
  try {
    const out = await callGroq([
      { role: "system", content: "You generate clean, relevant social media hashtags. Output ONLY JSON." },
      { role: "user", content: `Give ${count + 2} strong ${platform} hashtags for a post about: "${topic}". Rules: real, specific, recognizable tags (topics, technologies, companies, concepts); multi-word tags are PascalCase with NO spaces; NEVER generic filler/verbs (was, has, new, top, best, the); each 3-30 chars. Return ONLY JSON {"tags":["#Example","#AIAgents"]}.` },
    ], { json: true, temperature: 0.4 });
    return clean(parseJson(out).tags);
  } catch { return []; }
}

export async function trendingHashtags(topic, { platform = "linkedin", count = 3 } = {}) {
  const tags = await llmTags(topic, platform, count);
  if (tags.length < count) {
    const seen = new Set(tags.map((t) => t.toLowerCase()));
    for (const t of EVERGREEN) { if (tags.length >= count) break; if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); } }
  }
  return tags.slice(0, count);
}
