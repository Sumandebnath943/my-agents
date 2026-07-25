// agents/job-agent/ats.js — unified fetchers for free, public, no-auth ATS + remote boards.
//
// Every fetcher returns the same shape, and two fields matter beyond the obvious ones:
//   posted_at — ISO date, so filter.js can age stale reqs out. Null when the source doesn't say;
//               an undated role is never rejected for age.
//   salary    — raw pay text, so filter.js can apply the comp floor. Most sources say nothing.
const iso = (v) => {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v); // epoch s or ms
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Greenhouse: public JSON, no auth. content=true includes the full description.
export async function greenhouse(token) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`).then((x) => x.json());
  return (r.jobs || []).map((j) => ({
    title: j.title, company: token, location: j.location?.name || "",
    url: j.absolute_url, apply_url: j.absolute_url, ats: "greenhouse",
    posted_at: iso(j.first_published || j.updated_at), salary: "",
    description: (j.content || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").slice(0, 4000),
  }));
}
// Lever: public JSON, no auth.
export async function lever(site) {
  const r = await fetch(`https://api.lever.co/v0/postings/${site}?mode=json`).then((x) => x.json());
  return (Array.isArray(r) ? r : []).map((j) => ({
    title: j.text, company: site, location: j.categories?.location || "",
    url: j.hostedUrl, apply_url: j.applyUrl || j.hostedUrl, ats: "lever",
    posted_at: iso(j.createdAt), salary: j.salaryRange ? `${j.salaryRange.currency || ""} ${j.salaryRange.min || ""}-${j.salaryRange.max || ""}` : "",
    description: (j.descriptionPlain || "").slice(0, 4000),
  }));
}
// Ashby: public JSON, no auth.
export async function ashby(name) {
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${name}?includeCompensation=true`).then((x) => x.json());
  return (r.jobs || []).map((j) => ({
    title: j.title, company: name, location: j.location || "",
    url: j.jobUrl, apply_url: j.applyUrl || j.jobUrl, ats: "ashby",
    posted_at: iso(j.publishedAt), salary: j.compensation?.compensationTierSummary || "",
    description: (j.descriptionPlain || "").slice(0, 4000),
  }));
}
// Remote aggregators (free): RemoteOK JSON + Arbeitnow JSON.
export async function remoteBoards() {
  const out = [];
  try {
    const rk = await fetch("https://remoteok.com/api", { headers: { "User-Agent": "job-agent/1.0" } }).then((x) => x.json());
    out.push(...(Array.isArray(rk) ? rk : []).filter((j) => j.position).map((j) => ({
      title: j.position, company: j.company, location: j.location || "remote",
      url: j.url, apply_url: j.apply_url || j.url, ats: "remoteok",
      posted_at: iso(j.date || j.epoch), salary: j.salary_min ? `USD ${j.salary_min}-${j.salary_max || ""}` : "",
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    })));
  } catch {}
  try {
    const ab = await fetch("https://www.arbeitnow.com/api/job-board-api").then((x) => x.json());
    out.push(...(ab.data || []).map((j) => ({
      title: j.title, company: j.company_name, location: j.location || "remote",
      url: j.url, apply_url: j.url, ats: "arbeitnow",
      posted_at: iso(j.created_at), salary: "",
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    })));
  } catch {}
  return out;
}
