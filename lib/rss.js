// lib/rss.js — small shared RSS/Atom helpers.
import { XMLParser } from "fast-xml-parser";

// ignoreAttributes:false so we can read Atom <link href="..."> attributes.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function textOf(t) {
  return (t?.["#text"] ?? t ?? "").toString().trim();
}

// RSS uses <link>text</link>; Atom uses <link href="..."/> (possibly several).
export function linkHref(link) {
  if (!link) return "";
  const arr = Array.isArray(link) ? link : [link];
  const alt = arr.find((l) => (l?.["@_rel"] || "alternate") === "alternate") || arr[0];
  if (typeof alt === "string") return alt.trim();
  return (alt?.["@_href"] || alt?.["#text"] || "").toString().trim();
}

export async function fetchXml(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const xml = await fetch(url, { headers: { "accept-language": "en" }, signal: ctrl.signal }).then((r) => r.text());
    return parser.parse(xml);
  } finally {
    clearTimeout(t);
  }
}
