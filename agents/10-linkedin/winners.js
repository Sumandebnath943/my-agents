// agents/10-linkedin/winners.js
// "Learn from my own winners" — blends Suman's best-PERFORMING posts into the style exemplars
// alongside the curated reference posts in references.js.
//
// Until now the writer had no idea which of its own posts worked: 10d-recap fetched real likes and
// comments every Sunday, emailed them, and threw them away. Phase 2 started banking those numbers
// in `linkedin_engagement`; this is the half that reads them back.
//
// THREE GUARDS, because a naive version of this actively makes writing worse:
//   1. MIN_POSTS — ranking "winners" out of two posts just over-weights one lucky result. The block
//      stays empty (i.e. behaviour identical to today) until there is enough data to mean anything.
//   2. MIN_AGE_DAYS — LinkedIn engagement accrues for days. A post measured the morning after looks
//      like a flop next to a three-week-old one. Only matured posts are ranked.
//   3. Form, not content — 14 days also puts every winner outside the drafter's 14-day repetition
//      guard, so a winning post can never tempt the model into re-running its topic.
//
// All pure — no DB, no network — so it can be unit-eval'd offline.

export const MIN_POSTS = 5;       // qualified posts needed before winners are used at all
export const MIN_AGE_DAYS = 14;   // engagement matured + outside the repetition window
export const TOP_N = 3;           // how many winners to show

/** Comments cost more effort than likes, so they count double. Matches the SQL view's score. */
export const scoreOf = (s) => (Number(s?.likes) || 0) + 2 * (Number(s?.comments) || 0);

/**
 * Collapse the append-only sample history down to the NEWEST sample per post.
 * Samples arrive as { post_id, likes, comments, post_age_days, sampled_at }.
 */
export function latestSamples(samples) {
  const best = new Map();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || s.post_id == null) continue;
    const prev = best.get(s.post_id);
    if (!prev || String(s.sampled_at || "") > String(prev.sampled_at || "")) best.set(s.post_id, s);
  }
  return best;
}

/**
 * Rank posts by their latest engagement, keeping only matured ones with a real reading.
 * @param {Array} posts   rows from linkedin_posts (id, headline, post, created_at)
 * @param {Array} samples rows from linkedin_engagement
 * @returns {Array} qualified posts, best first
 */
export function rankWinners(posts, samples, { minAgeDays = MIN_AGE_DAYS } = {}) {
  const latest = latestSamples(samples);
  const out = [];
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p || p.id == null || !p.post) continue;
    const s = latest.get(p.id);
    if (!s) continue;                                        // never sampled
    const age = Number(s.post_age_days);
    if (!Number.isFinite(age) || age < minAgeDays) continue;  // too fresh to judge
    if (s.likes == null && s.comments == null) continue;      // LinkedIn exposed nothing
    out.push({ id: p.id, headline: p.headline || null, post: String(p.post), likes: s.likes ?? 0, comments: s.comments ?? 0, age, score: scoreOf(s) });
  }
  // Deterministic: score desc, then oldest first (a longer-matured post is the safer exemplar).
  return out.sort((a, b) => b.score - a.score || b.age - a.age || a.id - b.id);
}

/**
 * Render the winners as a few-shot block. Returns "" when there isn't enough data, which is what
 * keeps this a no-op until the history is worth learning from.
 */
export function winnersBlock(winners, { minPosts = MIN_POSTS, topN = TOP_N } = {}) {
  const list = Array.isArray(winners) ? winners : [];
  if (list.length < minPosts) return "";
  const shown = list.slice(0, topN).filter((w) => w.post?.trim());
  if (!shown.length) return "";
  return `\n\nMY OWN BEST-PERFORMING POSTS — these are real posts of mine that earned the most engagement (${list.length} matured posts ranked). They are the strongest evidence of what actually lands with MY audience, so weight their rhythm and structure ABOVE the generic exemplars. Copy the FORM only — never reuse their topic or claims, and never repeat a hook I've already used:\n${shown
    .map((w, i) => `--- MY TOP POST ${i + 1} (${w.likes} likes · ${w.comments} comments, ${w.age}d old) ---\n${w.post.trim()}`)
    .join("\n\n")}\n--- END MY TOP POSTS ---`;
}

/** One-line status for logs, so a run always says whether the loop is active and why. */
export function winnersStatus(winners, { minPosts = MIN_POSTS } = {}) {
  const n = (winners || []).length;
  return n >= minPosts
    ? `winners: active — ${n} matured post(s) ranked, top score ${winners[0].score}.`
    : `winners: dormant — ${n}/${minPosts} matured post(s) with engagement so far (needs ${MIN_AGE_DAYS}d+ old posts).`;
}
