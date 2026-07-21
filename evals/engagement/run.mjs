// evals/engagement/run.mjs
// Guards the LinkedIn engagement helpers (agents/10-linkedin/engagement.js). Pure + offline.
// These feed a table that Phase 3 will learn from, so a silent parsing regression here would
// poison the writer's idea of which posts worked.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { urnFromPostUrl, toCount, parseEngagement, ageDays, isSampleWorthStoring } from "../../agents/10-linkedin/engagement.js";

export function run() {
  const URN = "urn:li:share:7123456789";
  const urnCases = [
    { id: "plain url", in: `https://www.linkedin.com/feed/update/${URN}`, want: URN },
    { id: "trailing slash trimmed", in: `https://www.linkedin.com/feed/update/${URN}/`, want: URN },
    { id: "multiple trailing slashes", in: `https://www.linkedin.com/feed/update/${URN}///`, want: URN },
    { id: "query string stripped", in: `https://www.linkedin.com/feed/update/${URN}/?utm=x`, want: URN },
    { id: "hash stripped", in: `https://www.linkedin.com/feed/update/${URN}#c`, want: URN },
    { id: "ugcPost urn", in: "https://www.linkedin.com/feed/update/urn:li:ugcPost:99/", want: "urn:li:ugcPost:99" },
    { id: "no /update/ segment", in: "https://www.linkedin.com/in/suman", want: null },
    { id: "null input", in: null, want: null },
    { id: "undefined input", in: undefined, want: null },
    { id: "empty string", in: "", want: null },
    { id: "non-string", in: 12345, want: null },
    { id: "update with nothing after", in: "https://x.com/feed/update/", want: null },
  ];
  const urns = runCases("engagement · urn extraction", urnCases, (c) => {
    const got = urnFromPostUrl(c.in);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}` };
  });

  const countCases = [
    { id: "number passes through", in: 12, want: 12 },
    { id: "zero is preserved (not null)", in: 0, want: 0 },
    { id: "numeric string coerced", in: "34", want: 34 },
    { id: "null -> null", in: null, want: null },
    { id: "undefined -> null", in: undefined, want: null },
    { id: "empty string -> null", in: "", want: null },
    { id: "garbage -> null", in: "many", want: null },
    { id: "NaN -> null", in: NaN, want: null },
  ];
  const counts = runCases("engagement · count coercion", countCases, (c) => {
    const got = toCount(c.in);
    return { ok: Object.is(got, c.want), note: Object.is(got, c.want) ? "" : `got ${JSON.stringify(got)}` };
  });

  const parseCases = [
    { id: "totalLikes preferred", json: { likesSummary: { totalLikes: 10, aggregatedTotalLikes: 99 } }, want: { likes: 10, comments: null } },
    { id: "falls back to aggregated likes", json: { likesSummary: { aggregatedTotalLikes: 7 } }, want: { likes: 7, comments: null } },
    { id: "aggregated comments preferred", json: { commentsSummary: { aggregatedTotalComments: 3, count: 9 } }, want: { likes: null, comments: 3 } },
    { id: "falls back to comment count", json: { commentsSummary: { count: 4 } }, want: { likes: null, comments: 4 } },
    { id: "both present", json: { likesSummary: { totalLikes: 5 }, commentsSummary: { count: 2 } }, want: { likes: 5, comments: 2 } },
    { id: "zero engagement preserved", json: { likesSummary: { totalLikes: 0 }, commentsSummary: { count: 0 } }, want: { likes: 0, comments: 0 } },
    { id: "empty object", json: {}, want: { likes: null, comments: null } },
    { id: "null json", json: null, want: { likes: null, comments: null } },
    { id: "unexpected shape", json: { foo: "bar" }, want: { likes: null, comments: null } },
  ];
  const parsed = runCases("engagement · socialActions parsing", parseCases, (c) => {
    const got = parseEngagement(c.json);
    const ok = Object.is(got.likes, c.want.likes) && Object.is(got.comments, c.want.comments);
    return { ok, note: ok ? "" : `got ${JSON.stringify(got)}` };
  });

  const NOW = new Date("2026-07-21T12:00:00Z");
  const miscCases = [
    { id: "age same day = 0", check: () => ageDays("2026-07-21T01:00:00Z", NOW) === 0 },
    { id: "age 7 days", check: () => ageDays("2026-07-14T12:00:00Z", NOW) === 7 },
    { id: "age floors partial days", check: () => ageDays("2026-07-19T23:00:00Z", NOW) === 1 },
    { id: "future date clamps to 0", check: () => ageDays("2026-08-01T00:00:00Z", NOW) === 0 },
    { id: "invalid date -> null", check: () => ageDays("not-a-date", NOW) === null },
    { id: "store when likes present", check: () => isSampleWorthStoring({ post_urn: "u", likes: 3, comments: null }) === true },
    { id: "store when comments present", check: () => isSampleWorthStoring({ post_urn: "u", likes: null, comments: 1 }) === true },
    { id: "store a real zero", check: () => isSampleWorthStoring({ post_urn: "u", likes: 0, comments: 0 }) === true },
    { id: "skip when both unknown", check: () => isSampleWorthStoring({ post_urn: "u", likes: null, comments: null }) === false },
    { id: "skip when no urn", check: () => isSampleWorthStoring({ post_urn: null, likes: 5, comments: 5 }) === false },
    { id: "skip on null sample", check: () => isSampleWorthStoring(null) === false },
  ];
  const misc = runCases("engagement · age + store guard", miscCases, (c) => ({ ok: c.check() }));

  return [urns, counts, parsed, misc];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
