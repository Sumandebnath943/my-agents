// lib/hashtags.js — the hashtag engine. Pulls what's CURRENTLY used via Groq's web-search
// model, then GUARANTEES a result with a deterministic fallback (topic-derived tags + a
// curated evergreen AI set) so a post is never left tagless. Platform-tuned.
import { callGroq } from "./llm.js";

const EVERGREEN = ["#AI", "#GenAI", "#AIAgents", "#LLM", "#MachineLearning", "#Automation", "#FutureOfWork", "#Tech", "#Innovation", "#BuildInPublic"];
const STOP = new Set("the and for with that this from your about into new how why what when a an of to in on is are be as at by or its his her their our".split(" "));

const tagize = (word) => {
  const w = String(word).replace(/[^A-Za-z0-9]/g, "");
  return w ? "#" + w.charAt(0).toUpperCase() + w.slice(1) : "";
};
function fromTopic(topic, n) {
  const words = (String(topic).match(/[A-Za-z][A-Za-z0-9+]{2,}/g) || []).filter((w) => !STOP.has(w.toLowerCase()));
  const out = [];
  for (const w of words) { const t = tagize(w); if (t && !out.includes(t)) out.push(t); if (out.length >= n) break; }
  return out;
}

// Returns an array of clean `#Tag` strings (length = count), best/most-relevant first.
export async function trendingHashtags(topic, { platform = "linkedin", count = 3 } = {}) {
  let tags = [];
  try {
    const out = await callGroq(
      [{ role: "user", content: `Find the ${count} most relevant, currently-used ${platform} hashtags for a post about "${topic}" (audience: founders, AI builders, marketers). Reply with ONLY the hashtags, space-separated, each starting with #, no numbering or other text.` }],
      { model: "groq/compound", temperature: 0.3 }
    );
    tags = (out.match(/#[A-Za-z0-9_]+/g) || []).map((t) => t.replace(/_/g, ""));
  } catch { /* fall back below */ }

  const seen = new Set();
  tags = tags.filter((t) => t.length > 2 && t.length <= 32 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  if (tags.length < count) {
    for (const t of [...fromTopic(topic, count), ...EVERGREEN]) {
      const k = t.toLowerCase();
      if (tags.length >= count) break;
      if (t.length > 2 && !seen.has(k)) { seen.add(k); tags.push(t); }
    }
  }
  return tags.slice(0, count);
}
