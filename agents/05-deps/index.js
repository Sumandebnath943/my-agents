// agents/05-deps/index.js
import { env } from "../../lib/env.js";
import { OWNER, IGNORE } from "./repos.js";
import { callGemini, parseJson } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail } from "../../lib/email-template.js";

const gh = (path) =>
  fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${env("GH_PAT")}`, Accept: "application/vnd.github+json" },
  });

async function ghJson(path) {
  const r = await gh(path);
  return r.ok ? r.json() : null;
}

// Discover all repos you own that the token can see (auto-includes new ones).
async function ownedRepos() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ghJson(`/user/repos?affiliation=owner&per_page=100&page=${page}&sort=created&direction=desc`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// Read package.json via the contents API (works for private repos + any default branch).
async function readPackageJson(repo) {
  const data = await ghJson(`/repos/${OWNER}/${repo}/contents/package.json`);
  if (!data || !data.content) return null;
  try {
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function npmLatest(name) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${name}/latest`);
    return r.ok ? (await r.json()).version : null;
  } catch { return null; }
}

async function osvVulns(name, version) {
  // OSV.dev is a free vulnerability database, no key needed.
  const r = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" }, version }),
  });
  const data = r.ok ? await r.json() : {};
  return (data.vulns || []).map((v) => v.id);
}

const repos = (await ownedRepos())
  .filter((r) => !r.archived)
  .map((r) => r.name)
  .filter((n) => !IGNORE.includes(n));

const findings = [];
for (const repo of repos) {
  const pkg = await readPackageJson(repo);
  if (!pkg) continue; // not a Node repo (no package.json) — skip
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, range] of Object.entries(deps)) {
    const current = String(range).replace(/[^0-9.].*/, ""); // rough current version
    const latest = await npmLatest(name);
    const vulns = current ? await osvVulns(name, current) : [];
    if ((latest && latest !== current) || vulns.length) {
      findings.push({ repo, name, current, latest, vulns });
    }
  }
}

if (!findings.length) {
  console.log("No outdated or vulnerable deps found.");
} else {
  const out = await callGemini(
    `You are a security-savvy lead dev. Group these outdated/vulnerable npm packages by urgency.
Return ONLY JSON: {"security":[{"name":"","repo":"","note":""}],"major":[...],"minor":[...]}.
- security = has known vulnerabilities (act now). major = major-version bump. minor = minor/patch bump.
- note = one short line: what it is and whether to act.
Findings:\n${JSON.stringify(findings, null, 2)}`,
    { json: true }
  );
  let g = {};
  try { g = parseJson(out); } catch { g = {}; }
  const mk = (arr) => (arr || []).map((x) => ({
    title: `${x.name}${x.repo ? ` — ${x.repo}` : ""}`,
    note: x.note,
    link: `https://www.npmjs.com/package/${x.name}`,
  }));
  const blocks = [{ type: "stat", text: `🔐 ${findings.length} packages flagged across your repos` }];
  if (g.security?.length) blocks.push({ type: "listSection", ramp: "red", heading: "🔴 SECURITY — ACT NOW", items: mk(g.security) });
  if (g.major?.length) blocks.push({ type: "listSection", ramp: "amber", heading: "🟠 MAJOR BUMPS", items: mk(g.major) });
  if (g.minor?.length) blocks.push({ type: "listSection", ramp: "gray", heading: "⚪ MINOR / PATCH", items: mk(g.minor) });

  const html = renderEmail({
    title: "🔐 Dependency & Security Digest",
    kicker: "WEEKLY REPORT",
    accent: "#BA7517",
    blocks,
    footer: "Sources: npm registry + OSV.dev",
  });
  await notifyEmail("🔐 Weekly dependency & security digest", html);
  console.log(JSON.stringify(g, null, 2));
}
