// agents/brand-manager/extract.js
// Deterministic on-page SEO extraction. Pulls only the SEO-relevant fields (~500 tokens)
// so the LLM audit gets a trimmed input, and a content hash so unchanged pages can skip
// the LLM call entirely (reuse last week's audit).
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";

export function extractSeo(html) {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const fields = {
    title: $("title").first().text().trim(),
    metaDescription: $('meta[name="description"]').attr("content") || "",
    h1: $("h1").map((_, e) => $(e).text().trim()).get().slice(0, 5),
    h2: $("h2").map((_, e) => $(e).text().trim()).get().slice(0, 8),
    imagesMissingAlt: $("img").filter((_, e) => !$(e).attr("alt")).length,
    wordCount: text.split(" ").length,
    hasSchema: $('script[type="application/ld+json"]').length > 0,
    canonical: $('link[rel="canonical"]').attr("href") || "",
  };
  const hash = createHash("sha1").update(JSON.stringify(fields) + fields.wordCount).digest("hex");
  return { fields, hash };
}
