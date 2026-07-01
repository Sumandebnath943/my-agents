// lib/email-template.js
// Email-safe (inline styles + tables) renderer with a block system:
//   hero | tiles (bento) | listSection | stat | divider | text
// Tiles use inline-block so they sit side-by-side in Gmail/Apple Mail and stack on
// mobile without media queries. Outlook desktop stacks them and squares corners — fine.

const RAMPS = {
  purple: { bg: "#EEEDFE", text: "#3C3489", deep: "#26215C", solid: "#534AB7" },
  teal:   { bg: "#E1F5EE", text: "#0F6E56", deep: "#04342C", solid: "#0F6E56" },
  coral:  { bg: "#FAECE7", text: "#993C1D", deep: "#4A1B0C", solid: "#D85A30" },
  blue:   { bg: "#E6F1FB", text: "#185FA5", deep: "#042C53", solid: "#185FA5" },
  amber:  { bg: "#FAEEDA", text: "#854F0B", deep: "#412402", solid: "#BA7517" },
  green:  { bg: "#EAF3DE", text: "#3B6D11", deep: "#173404", solid: "#639922" },
  pink:   { bg: "#FBEAF0", text: "#993556", deep: "#4B1528", solid: "#D4537E" },
  red:    { bg: "#FCEBEB", text: "#A32D2D", deep: "#501313", solid: "#C0392B" },
  indigo: { bg: "#EEEDFE", text: "#3C3489", deep: "#26215C", solid: "#4A3F9E" },
  gray:   { bg: "#F1EFE8", text: "#5F5E5A", deep: "#2C2C2A", solid: "#888780" },
};
const ramp = (n) => RAMPS[n] || RAMPS.gray;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function tileHtml(t) {
  const r = ramp(t.ramp);
  const w = t.span === "full" ? "100%" : t.span === "half" ? "246px" : "158px";
  const block = t.span === "full";
  const bg = t.solid ? r.solid : r.bg;
  const labelColor = t.solid ? "#ffffff" : r.text;
  const valueColor = t.solid ? "#ffffff" : r.deep;
  const subColor = t.solid ? "rgba(255,255,255,0.85)" : r.text;
  const inner =
    (t.emoji ? `<div style="font-size:20px;line-height:1;">${t.emoji}</div>` : "") +
    (t.label ? `<div style="font-size:12px;font-weight:700;color:${labelColor};margin-top:6px;">${esc(t.label)}</div>` : "") +
    (t.headline
      ? `<a href="${esc(t.link)}" style="display:block;color:${valueColor};font-size:13.5px;font-weight:700;text-decoration:none;margin-top:5px;line-height:1.35;">${esc(t.headline)}</a>`
      : t.value
      ? `<div style="font-size:${t.solid ? "30px" : "18px"};font-weight:800;color:${valueColor};margin-top:2px;">${esc(t.value)}</div>`
      : "") +
    (t.sub ? `<div style="font-size:12px;color:${subColor};margin-top:3px;">${esc(t.sub)}</div>` : "");
  return `<div style="display:${block ? "block" : "inline-block"};vertical-align:top;box-sizing:border-box;width:${w};max-width:100%;background:${bg};border-radius:14px;padding:14px 16px;margin:4px;">${inner}</div>`;
}

function blockHtml(b) {
  if (b.type === "hero") {
    const r = ramp(b.ramp);
    const titleTag = b.link
      ? `<a href="${esc(b.link)}" style="display:block;color:${r.deep};font-size:18px;font-weight:800;text-decoration:none;margin-top:6px;line-height:1.3;">${esc(b.title)}</a>`
      : `<div style="color:${r.deep};font-size:18px;font-weight:800;margin-top:6px;line-height:1.3;">${esc(b.title)}</div>`;
    return `<div style="background:${r.bg};border-left:5px solid ${r.solid};border-radius:12px;padding:16px 18px;margin:6px 0;">
      ${b.kicker ? `<div style="font-size:10.5px;font-weight:700;letter-spacing:1px;color:${r.solid};">${esc(b.kicker)}</div>` : ""}
      ${titleTag}
      ${b.note ? `<div style="color:${r.text};font-size:13.5px;line-height:1.55;margin-top:6px;">${esc(b.note)}</div>` : ""}
      ${b.buttonLabel && b.link ? `<a href="${esc(b.link)}" style="display:inline-block;margin-top:10px;background:${r.solid};color:#ffffff;font-size:12.5px;font-weight:600;padding:8px 15px;border-radius:8px;text-decoration:none;">${esc(b.buttonLabel)}</a>` : ""}
    </div>`;
  }
  if (b.type === "tiles") {
    return `<div style="text-align:center;font-size:0;margin:6px 0;">${(b.items || []).map(tileHtml).join("")}</div>`;
  }
  if (b.type === "listSection") {
    const r = ramp(b.ramp);
    const head = b.heading
      ? `<div style="margin:16px 0 8px;"><span style="display:inline-block;background:${r.bg};color:${r.text};font-size:11px;font-weight:700;letter-spacing:.8px;padding:5px 12px;border-radius:20px;">${esc(b.heading)}</span></div>`
      : "";
    const items = (b.items || []).map((it, i) => `
      ${i > 0 ? `<div style="height:1px;background:#eeeeee;margin:14px 0;"></div>` : ""}
      <div>
        ${it.link ? `<a href="${esc(it.link)}" style="color:#1a1a2e;font-size:16px;font-weight:700;text-decoration:none;line-height:1.3;">${esc(it.title)}</a>` : `<div style="color:#1a1a2e;font-size:16px;font-weight:700;">${esc(it.title)}</div>`}
        ${it.note ? `<div style="color:#5a5a72;font-size:13px;line-height:1.55;margin-top:4px;">${esc(it.note)}</div>` : ""}
        ${it.buttonLabel && it.link
          ? `<a href="${esc(it.link)}" style="display:inline-block;margin-top:8px;background:${r.solid};color:#ffffff;font-size:12px;font-weight:600;padding:7px 13px;border-radius:7px;text-decoration:none;">${esc(it.buttonLabel)}</a>`
          : it.link ? `<a href="${esc(it.link)}" style="display:inline-block;margin-top:6px;color:${r.solid};font-size:12.5px;font-weight:600;text-decoration:none;">Read →</a>` : ""}
      </div>`).join("");
    return head + items;
  }
  if (b.type === "stat") {
    return `<div style="background:#F1EFE8;border-radius:12px;padding:12px 16px;text-align:center;margin:10px 0;color:#5F5E5A;font-size:12.5px;font-weight:600;">${esc(b.text)}</div>`;
  }
  if (b.type === "divider") return `<div style="height:1px;background:#eeeeee;margin:14px 0;"></div>`;
  if (b.type === "text") return `<div style="color:#3a3a4a;font-size:14px;line-height:1.6;margin:8px 0;">${b.html || esc(b.text)}</div>`;
  return "";
}

export function renderEmail({ title, subtitle = "", accent = "#534AB7", kicker = "", blocks = [], footer = "" }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eceef1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eceef1;padding:20px 10px;"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${accent};padding:24px 26px;">
        ${kicker ? `<div style="color:rgba(255,255,255,0.78);font-size:11px;letter-spacing:2px;font-weight:700;">${esc(kicker)}</div>` : ""}
        <div style="color:#ffffff;font-size:24px;font-weight:800;margin-top:6px;">${esc(title)}</div>
        ${subtitle ? `<div style="color:rgba(255,255,255,0.82);font-size:13px;margin-top:4px;">${esc(subtitle)}</div>` : ""}
      </td></tr>
      <tr><td style="padding:16px 22px;">${blocks.map(blockHtml).join("")}</td></tr>
      <tr><td style="background:#faf9fc;padding:14px 26px;color:#9a9aae;font-size:11px;text-align:center;">${esc(footer || "Sent by your agent system")}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// Back-compat: older sections-based digest -> listSection blocks.
export function renderDigest({ title, subtitle = "", sections = [], accent = "#534AB7", footer = "" }) {
  const cycle = ["purple", "teal", "coral", "blue", "amber", "pink"];
  const blocks = sections.map((s, i) => ({ type: "listSection", ramp: cycle[i % cycle.length], heading: s.heading, items: s.items }));
  return renderEmail({ title, subtitle, accent, blocks, footer });
}
