// agents/10-linkedin/engagement.js
// Pure helpers for reading LinkedIn engagement, extracted so they can be unit-eval'd offline
// (no network, no DB) — same pattern as agents/inbox-router/route.js.

/**
 * Pull the post URN out of a stored post_url.
 * LinkedIn URLs look like https://www.linkedin.com/feed/update/urn:li:share:123/ — note the
 * TRAILING SLASH, which the previous inline `split("/update/")[1]` kept. That slash survives
 * encodeURIComponent as %2F and makes the socialActions lookup miss, which is one reason posts
 * showed "engagement not exposed". Trimming it can only improve the hit rate.
 * @returns {string|null}
 */
export function urnFromPostUrl(postUrl) {
  if (typeof postUrl !== "string") return null;
  const after = postUrl.split("/update/")[1];
  if (!after) return null;
  const urn = after.split(/[?#]/)[0].replace(/\/+$/, "").trim();
  return urn || null;
}

/** Coerce a LinkedIn count to a number, or null when it is absent/garbage. 0 stays 0. */
export function toCount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read likes/comments out of a socialActions response. Field precedence is kept exactly as the
 * recap has always used it; only the "missing" representation changed (null instead of "?"), so
 * the value can go in an integer column. Callers render `?? "?"` for display.
 */
export function parseEngagement(json) {
  const j = json || {};
  return {
    likes: toCount(j.likesSummary?.totalLikes ?? j.likesSummary?.aggregatedTotalLikes),
    comments: toCount(j.commentsSummary?.aggregatedTotalComments ?? j.commentsSummary?.count),
  };
}

/** Whole days between a post's created_at and when the sample was taken (never negative). */
export function ageDays(createdAt, now = new Date()) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

/** True when we have something worth storing — a URN plus at least one real number. */
export function isSampleWorthStoring(sample) {
  if (!sample?.post_urn) return false;
  return sample.likes !== null || sample.comments !== null;
}
