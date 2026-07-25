// agents/job-agent/followup.js — the applications going quiet.
//
// Sourcing and applying were the loud problems; this is the silent one. An application sits in
// `applied` for five weeks, nobody chases it, and it neither becomes an interview nor gets marked
// dead — so the pipeline count says "12 in play" when the honest number is three.
//
// Thresholds differ by stage on purpose: silence after an interview is a much stronger signal than
// silence after an application, because the further along you are, the faster real employers move.
//
// Pure and offline — evals/job-dedupe covers it alongside the dedupe cases.

/** Days of silence before a stage is worth chasing. */
export const STALE_AFTER = {
  applied: 14,        // most companies screen within two weeks
  screening: 10,
  interviewing: 7,    // silence here is the loudest signal of the lot
  shortlisted: 7,     // YOU haven't acted — this one is a nudge at yourself
  offer: 3,
};

const ACTION = {
  shortlisted: "You shortlisted this and haven't applied. Apply or dismiss it — a stale shortlist is just guilt.",
  applied: "No response. Send a short follow-up to the recruiter, or mark it ghosted.",
  screening: "Screening has gone quiet. Ask for a status update.",
  interviewing: "No word since the interview. Follow up — this is the stage where silence usually means a decision was made.",
  offer: "An offer is outstanding. Don't let it lapse.",
};

/** Whole days between two instants, floored, never negative. */
export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 864e5));
}

/**
 * Which applications have gone quiet?
 * @param {Array<object>} rows  jobs rows with { status, applied_at, updated_at, created_at, ... }
 * @param {{now?: Date, thresholds?: object}} [opts]
 * @returns {Array<object>} stale roles, longest silence first
 */
export function staleApplications(rows = [], opts = {}) {
  const { now = new Date(), thresholds = STALE_AFTER } = opts;
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.status) continue;
    const limit = thresholds[r.status];
    if (limit == null) continue;                       // terminal or untracked stage
    // Last sign of life, most specific first. `updated_at` moves whenever you change anything,
    // so a role you touched yesterday is never called stale.
    const last = r.updated_at || r.applied_at || r.created_at;
    const days = daysSince(last, now);
    if (days == null || days < limit) continue;
    out.push({
      id: r.id,
      title: r.title,
      company: r.company,
      status: r.status,
      days,
      overdueBy: days - limit,
      action: ACTION[r.status] || "Follow up or close it out.",
      url: r.apply_url || r.url || null,
    });
  }
  return out.sort((a, b) => b.days - a.days);
}

/** One line for the weekly email. */
export function summarizeFollowups(stale) {
  if (!stale.length) return "";
  const worst = stale[0];
  return `${stale.length} application(s) gone quiet — longest is ${worst.title} @ ${worst.company}, ${worst.days} days`;
}
