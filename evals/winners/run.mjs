// evals/winners/run.mjs
// Guards the "learn from my own winners" loop (agents/10-linkedin/winners.js). Pure + offline.
//
// The GATING cases are the important ones. This feature is only safe because it stays completely
// inert until there's enough matured data — a version that ranked "winners" out of two fresh posts
// would over-weight one lucky result and make the writing worse than the curated exemplars it
// displaces. If these tests ever go green while the gate is open, the feature is a liability.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { rankWinners, winnersBlock, winnersStatus, latestSamples, scoreOf, MIN_POSTS, MIN_AGE_DAYS, TOP_N } from "../../agents/10-linkedin/winners.js";

const post = (id, extra = {}) => ({ id, headline: `H${id}`, post: `Body of post ${id}\n\nSecond line.`, ...extra });
const samp = (post_id, likes, comments, age, sampled_at = "2026-07-20T00:00:00Z") => ({ post_id, likes, comments, post_age_days: age, sampled_at });
// Six matured posts = enough to open the gate.
const POSTS = [1, 2, 3, 4, 5, 6].map((i) => post(i));
const SAMPLES = [samp(1, 10, 1, 30), samp(2, 100, 20, 30), samp(3, 5, 0, 30), samp(4, 50, 5, 30), samp(5, 1, 0, 30), samp(6, 20, 2, 30)];

export function run() {
  const scoring = runCases("winners · scoring + latest-sample", [
    { id: "score = likes + 2x comments", check: () => scoreOf({ likes: 10, comments: 3 }) === 16 },
    { id: "missing fields score 0", check: () => scoreOf({}) === 0 && scoreOf(null) === 0 },
    { id: "keeps the NEWEST sample per post", check: () => {
        const m = latestSamples([samp(1, 5, 0, 20, "2026-07-01T00:00:00Z"), samp(1, 90, 9, 30, "2026-07-20T00:00:00Z")]);
        return m.get(1).likes === 90;
      } },
    { id: "older sample never overwrites newer", check: () => {
        const m = latestSamples([samp(1, 90, 9, 30, "2026-07-20T00:00:00Z"), samp(1, 5, 0, 20, "2026-07-01T00:00:00Z")]);
        return m.get(1).likes === 90;
      } },
    { id: "ignores rows with no post_id", check: () => latestSamples([{ likes: 5 }, null]).size === 0 },
    { id: "non-array input safe", check: () => latestSamples(null).size === 0 },
  ], (c) => ({ ok: c.check() }));

  const ranking = runCases("winners · ranking + maturity filter", [
    { id: "ranks by score desc", check: () => rankWinners(POSTS, SAMPLES)[0].id === 2 },
    { id: "full order correct", check: () => rankWinners(POSTS, SAMPLES).map((w) => w.id).join() === "2,4,6,1,3,5" },
    { id: "drops posts younger than the maturity floor", check: () => rankWinners([post(9)], [samp(9, 999, 99, MIN_AGE_DAYS - 1)]).length === 0 },
    { id: "keeps a post exactly at the floor", check: () => rankWinners([post(9)], [samp(9, 5, 0, MIN_AGE_DAYS)]).length === 1 },
    { id: "drops never-sampled posts", check: () => rankWinners([post(9)], []).length === 0 },
    { id: "drops posts LinkedIn exposed nothing for", check: () => rankWinners([post(9)], [samp(9, null, null, 30)]).length === 0 },
    { id: "keeps a genuine zero-engagement post", check: () => rankWinners([post(9)], [samp(9, 0, 0, 30)]).length === 1 },
    { id: "drops posts with no body", check: () => rankWinners([{ id: 9, post: "" }], [samp(9, 10, 1, 30)]).length === 0 },
    { id: "malformed rows never throw", check: () => rankWinners([null, undefined, { id: null }], [null]).length === 0 },
    { id: "null inputs safe", check: () => rankWinners(null, null).length === 0 },
    { id: "deterministic across runs", check: () => JSON.stringify(rankWinners(POSTS, SAMPLES)) === JSON.stringify(rankWinners(POSTS, SAMPLES)) },
  ], (c) => ({ ok: c.check() }));

  const winners = rankWinners(POSTS, SAMPLES);
  const gating = runCases("winners · GATING (must stay inert until data is meaningful)", [
    { id: "empty -> no block", check: () => winnersBlock([]) === "" },
    { id: "null -> no block", check: () => winnersBlock(null) === "" },
    { id: "1 post -> no block", check: () => winnersBlock(winners.slice(0, 1)) === "" },
    { id: `${MIN_POSTS - 1} posts -> STILL no block`, check: () => winnersBlock(winners.slice(0, MIN_POSTS - 1)) === "" },
    { id: `${MIN_POSTS} posts -> block appears`, check: () => winnersBlock(winners.slice(0, MIN_POSTS)).length > 0 },
    { id: `shows at most ${TOP_N} posts`, check: () => (winnersBlock(winners).match(/--- MY TOP POST /g) || []).length === TOP_N },
    { id: "shows the best post first", check: () => winnersBlock(winners).indexOf("Body of post 2") < winnersBlock(winners).indexOf("Body of post 4") },
    { id: "includes engagement numbers", check: () => winnersBlock(winners).includes("100 likes · 20 comments") },
    { id: "instructs FORM only, not topic reuse", check: () => /Copy the FORM only/.test(winnersBlock(winners)) && /never reuse their topic/.test(winnersBlock(winners)) },
    { id: "tells the model to outweigh generic exemplars", check: () => /ABOVE the generic exemplars/.test(winnersBlock(winners)) },
    { id: "gate opens only on qualified count, not raw posts", check: () => winnersBlock(rankWinners(POSTS, SAMPLES.slice(0, 2))) === "" },
    { id: "blank-bodied winners can't fake the gate", check: () => winnersBlock(Array.from({ length: 6 }, (_, i) => ({ id: i, post: "   ", score: 1 }))) === "" },
  ], (c) => ({ ok: c.check() }));

  const status = runCases("winners · status line", [
    { id: "reports dormant with the count", check: () => /dormant — 2\/5/.test(winnersStatus(winners.slice(0, 2))) },
    { id: "reports active with the count", check: () => /active — 6 matured/.test(winnersStatus(winners)) },
    { id: "empty is dormant, not a crash", check: () => /dormant — 0\/5/.test(winnersStatus([])) },
    { id: "undefined is safe", check: () => winnersStatus(undefined).includes("dormant") },
  ], (c) => ({ ok: c.check() }));

  return [scoring, ranking, gating, status];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
