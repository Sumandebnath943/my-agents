// agents/cto/pdf.js — render the CTO patrol report to a PDF Buffer (pdfkit, no browser).
import PDFDocument from "pdfkit";

const INK = "#12131A", LIME = "#C6F24E", MUT = "#8A8B95";
const SEV = { high: "#E5484D", med: "#F5A623", low: "#8A8B95" };
const VERDICT = { request_changes: "#E5484D", comment: "#F5A623", approve: "#3BA55D", clean: "#3BA55D" };

// report = { date, totals:{repos,commits,issues}, repos:[{repo, commits, verdict, summary, issues:[{severity,category,note,where}], url}] }
export function renderCtoPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4", info: { Title: `CTO Review — ${report.date}` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, M = doc.page.margins.left, CW = W - M * 2;

    // Header band
    doc.rect(0, 0, W, 84).fill(INK);
    doc.circle(M + 8, 34, 9).fill(LIME);
    doc.fillColor("#fff").fontSize(20).font("Helvetica-Bold").text("CTO Review", M + 28, 24);
    doc.fillColor(MUT).fontSize(10).font("Helvetica").text(`Fleet code patrol · ${report.date}`, M + 28, 50);
    doc.y = 104;

    // Summary line
    const t = report.totals || {};
    doc.fillColor(INK).fontSize(11).font("Helvetica")
      .text(`Reviewed ${t.repos || 0} repo(s) with new activity · ${t.commits || 0} new commit(s) · ${t.issues || 0} issue(s) flagged`, M, doc.y);
    doc.moveDown(0.6);
    doc.moveTo(M, doc.y).lineTo(M + CW, doc.y).strokeColor("#E4E2DA").stroke();
    doc.moveDown(0.8);

    if (!report.repos?.length) {
      doc.fillColor(MUT).fontSize(12).text("No new commits across your repos since the last patrol. All quiet. ✅", M, doc.y);
      doc.end();
      return;
    }

    for (const r of report.repos) {
      if (doc.y > doc.page.height - 140) doc.addPage();
      // Repo heading + verdict chip
      const vColor = VERDICT[r.verdict] || MUT;
      doc.fillColor(INK).fontSize(14).font("Helvetica-Bold").text(r.repo, M, doc.y, { continued: true });
      doc.font("Helvetica").fontSize(9).fillColor("#fff");
      const label = ` ${(r.verdict || "clean").replace("_", " ").toUpperCase()} `;
      const lw = doc.widthOfString(label) + 4;
      const chipX = M + CW - lw, chipY = doc.y - 1;
      doc.text("", M, doc.y); // reset continued
      doc.rect(chipX, chipY, lw, 15).fill(vColor);
      doc.fillColor("#fff").fontSize(9).font("Helvetica-Bold").text(label, chipX + 2, chipY + 3, { width: lw, align: "center" });
      doc.moveDown(0.3);
      doc.fillColor(MUT).fontSize(9).font("Helvetica").text(`${r.commits || 0} new commit(s)`, M, doc.y);
      doc.moveDown(0.2);
      if (r.summary) doc.fillColor("#333").fontSize(10.5).font("Helvetica").text(r.summary, M, doc.y, { width: CW });
      doc.moveDown(0.4);

      for (const i of r.issues || []) {
        if (doc.y > doc.page.height - 80) doc.addPage();
        const sev = SEV[i.severity] || MUT;
        doc.circle(M + 4, doc.y + 6, 3).fill(sev);
        const head = `[${i.severity || "note"}/${i.category || "general"}] `;
        doc.fillColor(sev).fontSize(9.5).font("Helvetica-Bold").text(head, M + 14, doc.y, { continued: true });
        doc.fillColor("#222").font("Helvetica").fontSize(9.5).text(i.note + (i.where ? `  (${i.where})` : ""), { width: CW - 14 });
        doc.moveDown(0.15);
      }
      if (!(r.issues || []).length) { doc.fillColor("#3BA55D").fontSize(9.5).text("No issues found.", M + 14, doc.y); doc.moveDown(0.2); }
      doc.moveDown(0.6);
      doc.moveTo(M, doc.y).lineTo(M + CW, doc.y).strokeColor("#EFEDE6").stroke();
      doc.moveDown(0.7);
    }

    doc.end();
  });
}
