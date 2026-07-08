// agents/mas/run.js — the MAS SLOW PLANE (heavy missions) on GitHub Actions. Dispatched by
// the Vercel orchestrator with MISSION_ID. Uses MAS-only LLM keys (mapped into the standard
// env names by mas.yml, so lib/llm.js transparently uses them) and delivers results to the
// MAS bot + the MAS blackboard ONLY — never the main channels.
import { callLLM, parseJson } from "../../lib/llm.js";
import { profileContext } from "../../lib/profile.js";
import { getMission, updateMission, addMessage } from "./blackboard.js";
import { notifyMas, notifyMasLong, esc } from "./notify.js";

const MISSION_ID = process.env.MISSION_ID;
const profile = () => { try { return profileContext(); } catch { return ""; } };
const asJson = (s, fb = {}) => { try { return parseJson(s); } catch { return fb; } };

// ---- #1 Job Application War Room ----------------------------------------------------------
async function warroom(mission) {
  const [company, title] = String(mission.goal).split("|").map((s) => s.trim());
  await addMessage({ mission_id: mission.id, from_agent: "researcher", to_agent: "orchestrator", role: "observation", content: `researching ${company}` });

  const research = await callLLM([
    { role: "system", content: "Research this company for a job applicant using live web info. Return JSON {\"overview\":string,\"products\":string[],\"culture\":string,\"recent\":string[]}." },
    { role: "user", content: `Company: ${company}${title ? `, role: ${title}` : ""}` },
  ], { model: "groq/compound", agent: "mas", temperature: 0.3 }).catch(() => "");

  const cv = process.env.CV_TEXT || "";
  await addMessage({ mission_id: mission.id, from_agent: "orchestrator", to_agent: "critic", role: "plan", content: "score fit + draft cover + warm-up post" });

  const scoring = await callLLM(
    `You are an expert recruiter. Given the CANDIDATE CV, the ROLE at ${company}${title ? ` (${title})` : ""}, and COMPANY RESEARCH, return JSON {"fit":0-100,"strengths":string[],"gaps":string[],"keywords_to_add":string[]}. No fabrication.\n\nCV:\n${cv.slice(0, 6000)}\n\nRESEARCH:\n${String(research).slice(0, 4000)}`,
    { json: true, agent: "mas", temperature: 0.3 }
  ).catch(() => "{}");
  const fit = asJson(scoring);

  const cover = await callLLM(
    `Write a tailored, concise cover letter (max 220 words) for ${title || "this role"} at ${company}, grounded in the CV and company research. Warm, specific, no clichés, no fabricated metrics.\n\nCV:\n${cv.slice(0, 6000)}\n\nRESEARCH:\n${String(research).slice(0, 4000)}`,
    { agent: "mas", temperature: 0.5 }
  ).catch(() => "");

  const post = await callLLM(
    `Write a short LinkedIn post (max 120 words) warming up my network before I apply to ${company} — genuine interest in their space. Ground it in who I am below. Max 2 hashtags, ~1 emoji.\n\nABOUT ME:\n${profile()}`,
    { agent: "mas", temperature: 0.6 }
  ).catch(() => "");

  await updateMission(mission.id, { status: "done", result: { company, title, research: asJson(research, String(research).slice(0, 1500)), fit, cover, warmup_post: post } });
  await notifyMas(`💼 <b>Job War Room — ${esc(company)}${title ? ` · ${esc(title)}` : ""}</b>\nFit: <b>${fit.fit ?? "?"}/100</b>\n\n<b>Strengths:</b> ${esc((fit.strengths || []).slice(0, 3).join("; ")) || "—"}\n<b>Gaps:</b> ${esc((fit.gaps || []).slice(0, 3).join("; ")) || "—"}\n<b>Add keywords:</b> ${esc((fit.keywords_to_add || []).slice(0, 6).join(", ")) || "—"}`);
  await notifyMasLong(`✉️ <b>Cover letter</b>\n\n${esc(cover)}`);
  await notifyMasLong(`📣 <b>Warm-up post</b> (draft — post manually)\n\n${esc(post)}`);
}

// ---- #4 Content Engine --------------------------------------------------------------------
async function content(mission) {
  const kw = mission.goal || "latest in AI";
  const news = await callLLM([
    { role: "system", content: "Find the most relevant, recent AI/tech news for a post on the given topic. Return JSON {\"headline\":string,\"link\":string,\"why\":string}." },
    { role: "user", content: kw },
  ], { model: "groq/compound", agent: "mas", temperature: 0.3 }).catch(() => "");
  const n = asJson(news);

  const drafts = await callLLM(
    `Write 3 platform-tailored posts about "${kw}"${n.headline ? `, anchored on this news: ${n.headline} (${n.link || ""})` : ""}, grounded in who I am below. Return JSON {"linkedin":string,"buildinpublic":string,"bluesky":string}. Authentic voice, no fabricated metrics, LinkedIn under 220 words, Bluesky under 300 chars.\n\nABOUT ME:\n${profile()}`,
    { json: true, agent: "mas", temperature: 0.6 }
  ).catch(() => "{}");
  const d = asJson(drafts);

  await updateMission(mission.id, { status: "done", result: { topic: kw, news: n, drafts: d } });
  await notifyMas(`✍️ <b>Content Engine — ${esc(kw)}</b>${n.headline ? `\n📰 ${esc(n.headline)}` : ""}\n<i>Drafts below — review &amp; post manually (approval-gated by design).</i>`);
  if (d.linkedin) await notifyMasLong(`💼 <b>LinkedIn</b>\n\n${esc(d.linkedin)}`);
  if (d.buildinpublic) await notifyMasLong(`🛠️ <b>Build-in-public</b>\n\n${esc(d.buildinpublic)}`);
  if (d.bluesky) await notifyMasLong(`🦋 <b>Bluesky</b>\n\n${esc(d.bluesky)}`);
}

async function main() {
  if (!MISSION_ID) { console.error("no MISSION_ID"); return; }
  const mission = await getMission(MISSION_ID);
  if (!mission) { console.error("mission not found:", MISSION_ID); return; }
  try {
    if (mission.kind === "warroom") await warroom(mission);
    else if (mission.kind === "content") await content(mission);
    else await updateMission(mission.id, { status: "failed", result: { error: `unknown slow-plane kind: ${mission.kind}` } });
  } catch (e) {
    await updateMission(mission.id, { status: "failed", result: { error: String(e.message) } });
    await notifyMas(`⚠️ Mission failed: ${esc(e.message)}`);
  }
}
main();
