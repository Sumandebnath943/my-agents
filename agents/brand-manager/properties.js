// agents/brand-manager/properties.js
// tier: "full" | "path" | "perf". gscSite/gscFilter/ga4Property = null when not tracked.
//   full = PageSpeed + GSC rankings + GA4 traffic + on-page SEO audit
//   path = folder app under the Portfolio -> rides Portfolio GSC/GA4 via a path filter
//   perf = PageSpeed + SEO audit only (no per-site GSC/GA4 verification)
// GA4 property IDs filled in: HoN = 517699679, Portfolio = 543022176 (shared by its path apps).
export const PROPERTIES = [
  { name: "HoN", url: "https://houseofnamus.com/", tier: "full",
    gscSite: "sc-domain:houseofnamus.com", gscFilter: null, ga4Property: "properties/517699679" },
  { name: "Portfolio", url: "https://sumandebnath.houseofnamus.com/", tier: "full",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: null, ga4Property: "properties/543022176" },

  // folder pages under the Portfolio -> same GSC/GA4, filtered by path
  { name: "PACT", url: "https://sumandebnath.houseofnamus.com/agents/pact-agent", tier: "path",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: "/agents/pact-agent", ga4Property: "properties/543022176" },
  { name: "Pentashell", url: "https://sumandebnath.houseofnamus.com/agents/pentashell", tier: "path",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: "/agents/pentashell", ga4Property: "properties/543022176" },
  { name: "PentaCMD", url: "https://sumandebnath.houseofnamus.com/slms/pentacmd", tier: "path",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: "/slms/pentacmd", ga4Property: "properties/543022176" },
  { name: "Qdex", url: "https://sumandebnath.houseofnamus.com/llms/qdex-1.5b", tier: "path",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: "/llms/qdex-1.5b", ga4Property: "properties/543022176" },
  { name: "Forget Anything", url: "https://sumandebnath.houseofnamus.com/apps/forget-anything", tier: "path",
    gscSite: "https://sumandebnath.houseofnamus.com/", gscFilter: "/apps/forget-anything", ga4Property: "properties/543022176" },

  // performance + SEO audit only
  { name: "Imprint", url: "https://imprint.houseofnamus.com/", tier: "perf" },
  { name: "Legatus", url: "https://legatus.houseofnamus.com/", tier: "perf" },
  { name: "CITE", url: "https://cite.houseofnamus.com/", tier: "perf" },
  { name: "Slide Doctor", url: "https://slidedoctor.houseofnamus.com/", tier: "perf" },
  { name: "Ember", url: "https://ember.houseofnamus.com/", tier: "perf" },
  { name: "Crawl Daddy", url: "https://crawldaddy.houseofnamus.com/", tier: "perf" },
  { name: "Brief Killer", url: "https://briefkiller.houseofnamus.com/", tier: "perf" },
  { name: "Brief Killer 2", url: "https://briefkiller2.houseofnamus.com/", tier: "perf" },
  { name: "Repurpose AI", url: "https://repurposeai.houseofnamus.com/", tier: "perf" },
  { name: "D-PE AI", url: "https://d-pe.houseofnamus.com/", tier: "perf" },
  { name: "ROASmind", url: "https://roasmind.houseofnamus.com/", tier: "perf" },
  { name: "Soul Canvas", url: "https://soulcanvas.houseofnamus.com/", tier: "perf" },
  { name: "Shraddha Portfolio", url: "https://shraddhasonel.houseofnamus.com/", tier: "perf" },
  { name: "Migi", url: "https://migi.houseofnamus.com/", tier: "perf" },
  { name: "Crawl Daddy App", url: "https://crawldaddy--houseofnamus.replit.app/", tier: "perf" },
];
