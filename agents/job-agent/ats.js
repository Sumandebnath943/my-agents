// agents/job-agent/ats.js — unified fetchers for free, public, no-auth ATS + remote boards.
// Greenhouse: public JSON, no auth. content=true includes the full description.
export async function greenhouse(token) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`).then((x) => x.json());
  return (r.jobs || []).map((j) => ({
    title: j.title, company: token, location: j.location?.name || "",
    url: j.absolute_url, apply_url: j.absolute_url, ats: "greenhouse",
    description: (j.content || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").slice(0, 4000),
  }));
}
// Lever: public JSON, no auth.
export async function lever(site) {
  const r = await fetch(`https://api.lever.co/v0/postings/${site}?mode=json`).then((x) => x.json());
  return (Array.isArray(r) ? r : []).map((j) => ({
    title: j.text, company: site, location: j.categories?.location || "",
    url: j.hostedUrl, apply_url: j.applyUrl || j.hostedUrl, ats: "lever",
    description: (j.descriptionPlain || "").slice(0, 4000),
  }));
}
// Ashby: public JSON, no auth.
export async function ashby(name) {
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${name}?includeCompensation=true`).then((x) => x.json());
  return (r.jobs || []).map((j) => ({
    title: j.title, company: name, location: j.location || "",
    url: j.jobUrl, apply_url: j.applyUrl || j.jobUrl, ats: "ashby",
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
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    })));
  } catch {}
  try {
    const ab = await fetch("https://www.arbeitnow.com/api/job-board-api").then((x) => x.json());
    out.push(...(ab.data || []).map((j) => ({
      title: j.title, company: j.company_name, location: j.location || "remote",
      url: j.url, apply_url: j.url, ats: "arbeitnow",
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 4000),
    })));
  } catch {}
  return out;
}
