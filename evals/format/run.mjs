// evals/format/run.mjs
// Guards the LinkedIn post post-processors (agents/10-linkedin/format.js). Pure + offline.
//
// normalizeListMarkers exists because real posts shipped with "1️⃣ ... 2. ... 3." — the model spent
// its one allowed emoji on the first marker and wrote the rest as text. These cases lock that fix
// in, and just as importantly lock in what it must NOT touch: ordinary prose, already-consistent
// lists, and two separate lists that merely sit in the same post.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { normalizeListMarkers, withSignature, withCredit } from "../../agents/10-linkedin/format.js";
import { similarity, pickCardLine, candidateLines } from "../../agents/10-linkedin/card.js";
import { pullQuote, wrapText, fitText, cardSvg } from "../../agents/10-linkedin/card.js";
import { PROFILE } from "../../lib/profile.js";

const K = (d) => `${d}️⃣`;

export async function run() {   // async: the card-line checks await pickCardLine
  const fixCases = [
    {
      id: "the real bug: 1️⃣ then plain 2. 3.",
      in: `Here's the reality:\n${K(1)} Each new agent adds connections.\n2. A ticket traverses many agents.\n3. Governance becomes a nightmare.`,
      want: `Here's the reality:\n${K(1)} Each new agent adds connections.\n${K(2)} A ticket traverses many agents.\n${K(3)} Governance becomes a nightmare.`,
    },
    {
      id: "starts plain -> stays plain throughout",
      in: `1. First point\n${K(2)} Second point\n3. Third point`,
      want: "1. First point\n2. Second point\n3. Third point",
    },
    {
      id: "misnumbered plain list is renumbered",
      in: "1. alpha\n3. beta\n7. gamma",
      want: "1. alpha\n2. beta\n3. gamma",
    },
    {
      id: "paren markers normalise too",
      in: `1) alpha\n${K(2)} beta`,
      want: "1. alpha\n2. beta",
    },
    {
      id: "list longer than 9 falls back to plain",
      in: `${K(1)} a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n10. j`,
      want: "1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n10. j",
    },
    {
      id: "indentation is preserved",
      in: `  ${K(1)} alpha\n  2. beta`,
      want: `  ${K(1)} alpha\n  ${K(2)} beta`,
    },
  ];
  const fixes = runCases("format · numbered lists get one consistent style", fixCases, (c) => {
    const got = normalizeListMarkers(c.in);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${JSON.stringify(got)}` };
  });

  const leaveCases = [
    { id: "already consistent keycaps untouched", in: `${K(1)} a\n${K(2)} b\n${K(3)} c` },
    { id: "already consistent plain untouched", in: "1. a\n2. b\n3. c" },
    { id: "a lone marker is never guessed at", in: `${K(1)} the only numbered line\nthis is prose, not an item` },
    { id: "prose with no markers untouched", in: "I shipped 3 agents this week.\nIt took 2 days." },
    { id: "bullets are not touched", in: "• alpha\n• beta\n• gamma" },
    { id: "a year at line start is not a marker", in: "2026 was the year.\n2027 will be bigger." },
    { id: "empty string safe", in: "" },
    { id: "null safe", in: null },
    { id: "non-string safe", in: 42 },
  ];
  const left = runCases("format · leaves everything else alone", leaveCases, (c) => {
    const got = normalizeListMarkers(c.in);
    return { ok: got === c.in, note: got === c.in ? "" : `mutated to ${JSON.stringify(got)}` };
  });

  // Two independent lists in one post must not be merged into one 1..6 run.
  const twoLists = `${K(1)} a\n2. b\n\nSome prose in between that is long enough to separate them.\nMore prose here.\nAnd another line of prose.\n\n1. x\n${K(2)} y`;
  const twoOut = normalizeListMarkers(twoLists);
  const groupCases = [
    { id: "second list restarts at 1, not 3", check: () => /\n1\. x|\n1️⃣ x/.test(twoOut) },
    { id: "first list still ends at 2", check: () => !/3[.)]|3️⃣/.test(twoOut) },
  ];
  const groups = runCases("format · separate lists stay separate", groupCases, (c) => ({ ok: c.check() }));

  const SIG = "Posted by my AI agent MIGI";
  const sigCases = [
    { id: "appends the signature", check: () => withSignature("Hello world", SIG) === `Hello world\n\n${SIG}` },
    { id: "idempotent — never signs twice", check: () => withSignature(`Hello\n\n${SIG}`, SIG) === `Hello\n\n${SIG}` },
    { id: "case-insensitive duplicate guard", check: () => withSignature(`Hello\n\n${SIG.toUpperCase()}`, SIG) === `Hello\n\n${SIG.toUpperCase()}` },
    { id: "trailing whitespace collapsed before signing", check: () => withSignature("Hello   \n\n\n", SIG) === `Hello\n\n${SIG}` },
    { id: "empty signature is a no-op", check: () => withSignature("Hello", "") === "Hello" },
    { id: "null signature is a no-op", check: () => withSignature("Hello", null) === "Hello" },
    { id: "empty post stays empty", check: () => withSignature("", SIG) === "" },
    { id: "non-string post safe", check: () => withSignature(null, SIG) === null },
  ];
  const sigs = runCases("format · signature", sigCases, (c) => ({ ok: c.check() }));

  // The card is built from ONE pulled line, so a bad pull is a bad image. These lock in what must
  // never reach the card: hashtags, the agent signature, list markers, bare questions.
  const AGENT_SIG = "🤖 Drafted by MIGI, my AI agent — edited and published by me.";
  const quoteCases = [
    { id: "hashtag lines are skipped", check: () => pullQuote("#AI #agents\nThe real constraint is accountability, not model quality at all.").startsWith("The real") },
    { id: "the signature never becomes the quote", check: () => !pullQuote(`A genuinely long and quotable sentence about agents and accountability here.\n\n${AGENT_SIG}`).includes("MIGI") },
    { id: "list markers are stripped", check: () => !/^[0-9]/.test(pullQuote(`${K(1)} Each new agent adds connections and multiplies the total complexity.`)) },
    { id: "bare URLs are skipped", check: () => !pullQuote("https://example.com/a-very-long-url-that-should-not-be-quoted-here\nAccountability is the real constraint on agent systems today.").startsWith("http") },
    { id: "prefers a claim over a question", check: () => !pullQuote("Is this the end of prompt engineering as we know it today?\nThe bottleneck was never model quality, it was always accountability.").endsWith("?") },
    { id: "empty input is safe", check: () => pullQuote("") === "" },
    { id: "null input is safe", check: () => typeof pullQuote(null) === "string" },
  ];
  const quotes = runCases("card · pull quote", quoteCases, (c) => ({ ok: c.check() }));

  const layoutCases = [
    { id: "long text wraps to many lines", check: () => wrapText("word ".repeat(80), 40, 900).length > 1 },
    { id: "short text stays on one line", check: () => wrapText("three short words", 40, 900).length === 1 },
    { id: "an unbreakable token still yields a line", check: () => wrapText("x".repeat(300), 40, 900).length >= 1 },
    { id: "font shrinks for long copy", check: () => fitText("x ".repeat(160), { maxWidth: 900, maxHeight: 600 }).size < fitText("short line", { maxWidth: 900, maxHeight: 600 }).size },
    { id: "never returns a size below the floor", check: () => fitText("y ".repeat(900), { maxWidth: 400, maxHeight: 200 }).size >= 34 },
    { id: "svg escapes angle brackets", check: () => cardSvg({ quote: "a <script> tag" }).includes("&lt;script&gt;") },
    { id: "svg escapes ampersands", check: () => cardSvg({ quote: "Tom & Jerry & co" }).includes("&amp;") },
    { id: "svg root is well formed", check: () => cardSvg({ quote: "hello world" }).startsWith("<svg") && cardSvg({ quote: "hi" }).trimEnd().endsWith("</svg>") },
    // Count only what RENDERS: source comments mention MIGI and must not fail this.
    { id: "watermark never prints MIGI twice", check: () => {
      const visible = cardSvg({ quote: "hello world" }).replace(/<!--[\s\S]*?-->/g, "");
      return (visible.match(/MIGI/g) || []).length === 1;
    } },
    { id: "a custom watermark is honoured", check: () => cardSvg({ quote: "hi", watermark: "Made by" }).includes(">Made by<") },
    // A card once shipped showing an invented "sumandebnath.com". The footer must come from
    // lib/profile.js and match the real portfolio host, which is houseofnamUS.
    { id: "footer uses the real portfolio domain", check: () => cardSvg({ quote: "hi" }).includes(PROFILE.site) },
    { id: "the real domain is houseofnamus, not a bare apex", check: () => /^sumandebnath\.houseofnamus\.com$/.test(PROFILE.site) },
    { id: "no invented apex domain anywhere on the card", check: () => !/[^.]sumandebnath\.com/.test(cardSvg({ quote: "hi" })) },
    // Backdrop: must vary between posts but stay reproducible, and must never be loud enough to
    // fight the quote. An opacity above ~0.12 on a background layer would start doing that.
    { id: "same quote renders an identical card", check: () => cardSvg({ quote: "the same line twice" }) === cardSvg({ quote: "the same line twice" }) },
    { id: "different quotes get different backdrops", check: () => {
      const a = cardSvg({ quote: "one distinct line about agents entirely" }).match(/<circle cx="(\d+)" cy="(\d+)" r="\d+" stroke-width/);
      const b = cardSvg({ quote: "a wholly different line about models here" }).match(/<circle cx="(\d+)" cy="(\d+)" r="\d+" stroke-width/);
      return a && b && (a[1] !== b[1] || a[2] !== b[2]);
    } },
    { id: "no backdrop layer is loud enough to fight the text", check: () => {
      const svg = cardSvg({ quote: "hello world" });
      const opacities = [...svg.matchAll(/(?:\bopacity|stop-opacity)="([0-9.]+)"/g)].map((m) => Number(m[1]));
      // The vignette is black and deliberately stronger; every accent layer stays faint.
      return opacities.filter((o) => o > 0 && o < 0.3).every((o) => o <= 0.12);
    } },
    { id: "the quote still renders over the backdrop", check: () => cardSvg({ quote: "legible line" }).includes(">legible<") || cardSvg({ quote: "legible line" }).includes("legible line") },
  ];
  const layout = runCases("card · layout + escaping", layoutCases, (c) => ({ ok: c.check() }));

  const creditCases = [
    { id: "appends the credit", check: () => withCredit("Body text", "VentureBeat") === "Body text\n\nVia VentureBeat" },
    { id: "idempotent — never credits twice", check: () => withCredit("Body\n\nVia VentureBeat", "VentureBeat") === "Body\n\nVia VentureBeat" },
    { id: "unknown source is a no-op", check: () => withCredit("Body", "unknown") === "Body" },
    { id: "empty source is a no-op", check: () => withCredit("Body", "") === "Body" },
    { id: "null source is a no-op", check: () => withCredit("Body", null) === "Body" },
    { id: "empty body stays empty", check: () => withCredit("", "VentureBeat") === "" },
    { id: "a regex-special source name is escaped, not interpreted", check: () => withCredit("Body", "A.B (C)") === "Body\n\nVia A.B (C)" },
    { id: "credit then signature reads in the right order", check: () => {
      const out = withSignature(withCredit("Body", "The Verge"), "🤖 Drafted by MIGI");
      return out.indexOf("Via The Verge") < out.indexOf("MIGI") && out.startsWith("Body");
    } },
  ];
  const credits = runCases("format · source credit", creditCases, (c) => ({ ok: c.check() }));

  // THE REAL INCIDENT: a card shipped carrying 92% of VentureBeat's headline in 70px type under
  // Suman's name. These lock the gate that prevents it — including the subtle trap that a mere
  // REWORD is not a fix ("act on their own" -> "act autonomously" is still the same headline).
  const VB_HEADLINE = "When agents act on their own, governance has to live in the data layer";
  const RESTATEMENT = "When agents act autonomously, governance has to live in the data layer.";
  const REAL_POST = [
    RESTATEMENT,
    "As AI systems gain independence, the real question becomes how we make sure they act responsibly.",
    "Governance can't be an afterthought; embed enforceable rules directly where data is read or written.",
    "In my work with AI-native products, I've seen how this data-layer approach kept the IMPRINT engine compliant.",
    "The future of AI isn't just about what agents can do—it's about how we control what they do.",
  ].join("\n\n");

  const simCases = [
    { id: "a reworded headline scores HIGH", check: () => similarity(RESTATEMENT, VB_HEADLINE) > 0.8 },
    { id: "an independent line scores LOW", check: () => similarity("The future of AI isn't just about what agents can do—it's about how we control what they do.", VB_HEADLINE) < 0.4 },
    { id: "identical strings score 1", check: () => similarity(VB_HEADLINE, VB_HEADLINE) === 1 },
    { id: "unrelated strings score 0", check: () => similarity("Rain fell on the quiet harbour town", VB_HEADLINE) === 0 },
    { id: "a headline swallowed by a longer line still scores high", check: () => similarity(`Honestly, ${VB_HEADLINE}, and that changes everything for builders.`, VB_HEADLINE) > 0.8 },
    { id: "empty input is safe", check: () => similarity("", VB_HEADLINE) === 0 },
  ];
  const sims = runCases("card · source similarity", simCases, (c) => ({ ok: c.check() }));

  const pickCases = [
    { id: "the claim outranks the credential line", check: async () => candidateLines(REAL_POST)[0].startsWith("The future of AI") },
    { id: "the headline restatement is NOT chosen", check: async () => (await pickCardLine(REAL_POST, { sourceHeadline: VB_HEADLINE })).line !== RESTATEMENT },
    { id: "chosen line clears the bar", check: async () => (await pickCardLine(REAL_POST, { sourceHeadline: VB_HEADLINE })).similarity <= 0.6 },
    { id: "no source headline -> best candidate, no gate", check: async () => (await pickCardLine(REAL_POST, {})).via === "original" },
    { id: "a GENUINE rephrase is accepted", check: async () => {
      const r = await pickCardLine(RESTATEMENT, { sourceHeadline: VB_HEADLINE, rephrase: async () => "Autonomy without control is just risk moving faster." });
      return r.via === "rephrased" && r.line.startsWith("Autonomy");
    } },
    { id: "a mere REWORD is rejected, not trusted", check: async () => {
      const r = await pickCardLine(RESTATEMENT, { sourceHeadline: VB_HEADLINE, rephrase: async () => "When agents act on their own, governance must live in the data layer." });
      return r.via !== "rephrased";
    } },
    { id: "when nothing clears the bar, NO card is made", check: async () => (await pickCardLine(RESTATEMENT, { sourceHeadline: VB_HEADLINE })).line === null },
    { id: "a throwing rephraser degrades safely", check: async () => {
      const r = await pickCardLine(RESTATEMENT, { sourceHeadline: VB_HEADLINE, rephrase: async () => { throw new Error("llm down"); } });
      return r.line === null && r.via === "blocked";
    } },
  ];
  const picks = await runCasesAsync("card · never restates the source", pickCases);

  return [fixes, left, groups, sigs, quotes, layout, credits, sims, picks];
}

/** runCases is sync; these checks are async, so mirror its shape and reporting. */
async function runCasesAsync(label, cases) {
  let pass = 0, fail = 0;
  const fails = [];
  console.log(`\n▶ ${label}`);
  for (const c of cases) {
    let ok = false, note = "";
    try { ok = !!(await c.check()); } catch (e) { note = `threw: ${e.message}`; }
    if (ok) { pass++; console.log(`  ✓ ${c.id}`); }
    else { fail++; fails.push({ id: c.id, note }); console.log(`  ✗ ${c.id} ${note}`); }
  }
  console.log(`  ${pass}/${cases.length} passed — ${fail ? `${fail} FAILED` : "all green"}`);
  return { label, pass, fail, fails };
}

if (isMain(import.meta.url)) {
  const results = await run();
  if (results.some((r) => r.fail)) process.exit(1);
}
