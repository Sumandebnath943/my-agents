// agents/build-compass/sources.js — datacenter-reliable demand sources with engagement + comments.
// HN (Algolia) exposes points, comment counts, and full comment trees; Lobste.rs exposes score +
// comment_count. (Reddit engagement/comments aren't available from a datacenter — see lib/reddit.js —
// so Reddit is added by the collector for post BODIES/recurrence, not engagement.)
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

async function hnSearch(tags, query, n = 40) {
  const p = new URLSearchParams({ hitsPerPage: String(n) });
  if (tags) p.set("tags", tags);
  if (query) p.set("query", query);
  const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${p}`).then((x) => x.json()).catch(() => ({ hits: [] }));
  return (r.hits || []).map((h) => ({
    source: "HN",
    title: h.title || h.story_title || "",
    body: strip(h.story_text || ""),
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    objectID: h.objectID,
    points: h.points ?? null,
    num_comments: h.num_comments ?? null,
  })).filter((x) => x.title);
}

// Demand-expressing HN posts: Ask HN + Show HN + phrases where people voice unmet needs.
export async function hnDemand() {
  const out = [];
  out.push(...(await hnSearch("ask_hn", null, 40)));
  out.push(...(await hnSearch("show_hn", null, 15)));
  for (const q of ["looking for a tool", "is there a tool", "recommend a tool", "how do you handle", "wish there was"]) {
    out.push(...(await hnSearch(null, q, 12)));
  }
  const seen = new Set();
  return out.filter((i) => { if (!i.objectID || seen.has(i.objectID)) return i.objectID ? false : true; seen.add(i.objectID); return true; });
}

// Top comments for an HN thread — this is the "what are people actually asking for" signal.
export async function hnComments(objectID, max = 8) {
  try {
    const it = await fetch(`https://hn.algolia.com/api/v1/items/${objectID}`).then((r) => r.json());
    const texts = [];
    const walk = (node) => { for (const c of node.children || []) { if (texts.length >= max) return; if (c.text) texts.push(strip(c.text)); walk(c); } };
    walk(it);
    return texts.slice(0, max).join("  ||  ").slice(0, 1500);
  } catch { return ""; }
}

export async function lobsters() {
  try {
    const l = await fetch("https://lobste.rs/newest.json", { headers: { "User-Agent": "migi-agents/1.0" } }).then((r) => r.json());
    return (Array.isArray(l) ? l : []).slice(0, 40).map((p) => ({
      source: "Lobsters",
      title: p.title || "",
      body: strip(p.description || ""),
      url: p.url || p.short_id_url || "",
      objectID: null,
      points: p.score ?? null,
      num_comments: p.comment_count ?? null,
    })).filter((x) => x.title);
  } catch { return []; }
}
