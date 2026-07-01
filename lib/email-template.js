// lib/email-template.js
// Renders a clean, email-client-safe HTML digest (inline styles + tables).
// sections: [{ heading, items: [{ title, note, link }] }]
export function renderDigest({ title, subtitle = "", sections = [], accent = "#6C5CE7", footer = "" }) {
  const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemHtml = (it) => {
    const t = esc(it.title);
    const titleHtml = it.link
      ? `<a href="${esc(it.link)}" style="color:#1a1a2e;text-decoration:none;font-weight:600;font-size:15px;">${t}</a>`
      : `<span style="color:#1a1a2e;font-weight:600;font-size:15px;">${t}</span>`;
    const note = it.note
      ? `<div style="color:#5a5a72;font-size:13px;line-height:1.5;margin-top:3px;">${esc(it.note)}</div>`
      : "";
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;">${titleHtml}${note}</td></tr>`;
  };

  const sectionHtml = (s) => `
    <tr><td style="padding:22px 0 8px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${accent};">${esc(s.heading)}</div>
    </td></tr>
    ${(s.items || []).map(itemHtml).join("")}`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
        <tr><td style="background:${accent};padding:26px 28px;">
          <div style="color:#ffffff;font-size:22px;font-weight:700;">${esc(title)}</div>
          ${subtitle ? `<div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px;">${esc(subtitle)}</div>` : ""}
        </td></tr>
        <tr><td style="padding:6px 28px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${sections.map(sectionHtml).join("")}
          </table>
        </td></tr>
        <tr><td style="padding:16px 28px;background:#fafafa;color:#9a9aae;font-size:11px;text-align:center;">
          ${esc(footer || "Sent by your agent system")}
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}
