// agents/10-linkedin/format.js
// Pure post-processing for generated LinkedIn copy — no network, no DB, so it can be unit-eval'd
// (same pattern as engagement.js).
//
// WHY normalizeListMarkers EXISTS: the writing playbook said "at most 1 emoji, used as a marker
// (e.g. a list glyph)". The model obeyed that literally — it spent its one allowed emoji on "1️⃣"
// and then wrote "2." and "3." as plain text, producing the ragged lists seen in real posts. The
// playbook wording is fixed too, but a prompt is a request and this is a guarantee.

const KEYCAP = (d) => `${d}️⃣`;                 // 1 -> 1️⃣
const RE_KEYCAP = /^([ \t]*)([0-9])️?⃣[ \t]*/;   // "1️⃣ " at line start
const RE_PLAIN = /^([ \t]*)([0-9]{1,2})[.)][ \t]+/;        // "1. " / "1) " at line start

/**
 * Make every marker in a numbered list use the SAME style, and renumber it 1..n.
 *
 * Scope is deliberately conservative — it only ever rewrites lines that ALREADY carry a numeric
 * marker. It never invents a marker for an unnumbered line, because deciding whether a bare line
 * is a list item or ordinary prose cannot be done reliably, and a wrong guess mangles the post.
 *
 * Separate lists stay separate: a new group starts whenever the numbering restarts at 1, or when
 * more than 4 lines separate one numbered line from the next.
 *
 * @param {string} text
 * @returns {string} text with consistent markers; the input unchanged if there is nothing to fix
 */
export function normalizeListMarkers(text) {
  if (typeof text !== "string" || !text) return text;
  const lines = text.split("\n");

  // 1. Find every line that already carries a numeric marker.
  const marked = [];
  for (let i = 0; i < lines.length; i++) {
    const k = RE_KEYCAP.exec(lines[i]);
    if (k) { marked.push({ i, kind: "keycap", num: Number(k[2]), indent: k[1] }); continue; }
    const p = RE_PLAIN.exec(lines[i]);
    if (p) marked.push({ i, kind: "plain", num: Number(p[2]), indent: p[1] });
  }
  // A LONE MARKER IS NEVER A LIST. Observed in a real draft: the model opened a framework with
  // "1. Build a shared context layer", then wrote seven indented explainer lines instead of items
  // 2 and 3 — so the post shipped with a single orphaned "1.".
  //
  // Strip it rather than invent siblings. Numbering those explainers would have produced
  // "2. A single source of truth lets..." — confidently wrong, and worse than the original. The
  // asymmetry is the point: REMOVING a stray marker cannot corrupt prose, ADDING one can.
  if (marked.length === 1 && marked[0].num === 1) {
    const m = marked[0];
    lines[m.i] = m.indent + lines[m.i].replace(m.kind === "keycap" ? RE_KEYCAP : RE_PLAIN, "");
    return lines.join("\n");
  }
  if (marked.length < 2) return text;   // any other lone marker: leave well alone

  // 2. Split into groups: numbering restarting at 1, or a big gap, means a new list.
  const groups = [];
  let cur = [marked[0]];
  for (let n = 1; n < marked.length; n++) {
    const prev = marked[n - 1], m = marked[n];
    if (m.num === 1 || m.i - prev.i > 4) { groups.push(cur); cur = [m]; }
    else cur.push(m);
  }
  groups.push(cur);

  // 3. Fix only the groups that are actually inconsistent.
  let changed = false;
  for (const g of groups) {
    if (g.length < 2) continue;
    const mixedStyle = g.some((m) => m.kind !== g[0].kind);
    const misNumbered = g.some((m, n) => m.num !== n + 1);
    if (!mixedStyle && !misNumbered) continue;

    // Follow the style the list STARTED with — that is the author's evident intent. Keycaps only
    // exist for single digits, so a list longer than 9 falls back to plain numbers throughout.
    const useKeycap = g[0].kind === "keycap" && g.length <= 9;
    g.forEach((m, n) => {
      const num = n + 1;
      const body = lines[m.i].replace(m.kind === "keycap" ? RE_KEYCAP : RE_PLAIN, "");
      lines[m.i] = `${m.indent}${useKeycap ? `${KEYCAP(num)} ` : `${num}. `}${body}`;
    });
    changed = true;
  }

  return changed ? lines.join("\n") : text;
}

/**
 * Strip the whitespace artefacts LinkedIn renders literally.
 *
 * LinkedIn has no indentation and no leading-space collapsing: the model's tidy three-space indent
 * under a list item arrives on the feed as a visible ragged gap before the sentence. Real drafts
 * also carried trailing double-spaces (a markdown line-break idiom that means nothing here) and
 * "blank" lines made of spaces, which render as an extra empty row.
 *
 * Structure is preserved — blank lines still separate blocks, they just stop being made of spaces.
 */
export function tidyWhitespace(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/[ \t]+$/gm, "")        // trailing spaces (incl. the markdown two-space break)
    .replace(/^[ \t]+/gm, "")        // leading indent — LinkedIn shows it as a literal gap
    .replace(/\n{3,}/g, "\n\n")      // never more than one blank line between blocks
    .trim();
}

/**
 * Append a source credit, idempotently.
 *
 * WHY: the post's prose is original — measured 0% six-word overlap with the source article — but
 * it is still *about* someone else's reporting, and shipping it with no acknowledgement reads as
 * passing off. A plain text credit is deliberate: a raw URL in the body suppresses LinkedIn reach,
 * so the link belongs in the first comment while the credit belongs in the post.
 */
export function withCredit(text, source) {
  if (typeof text !== "string" || !text.trim()) return text;
  const s = String(source || "").trim();
  if (!s || s === "unknown") return text;
  const line = `Via ${s}`;
  const body = text.replace(/\s+$/, "");
  if (new RegExp(`^via\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im").test(body)) return body;
  return `${body}\n\n${line}`;
}

/**
 * Append the agent signature, idempotently.
 * Returns the text unchanged when `sig` is empty or already present, so re-running an edit or a
 * regenerate can never stack two signatures on one post.
 */
export function withSignature(text, sig) {
  if (typeof text !== "string" || !text.trim()) return text;
  const s = String(sig || "").trim();
  if (!s) return text;
  const body = text.replace(/\s+$/, "");
  if (body.toLowerCase().includes(s.toLowerCase())) return body;   // already signed
  return `${body}\n\n${s}`;
}
