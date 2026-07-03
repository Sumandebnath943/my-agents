// agents/job-agent/config.js — your targeting. This list IS your job-search strategy; grow it.
export const TITLES = [
  "Senior Product Marketing Manager", "Product Marketing Manager", "Product Marketing Lead",
  "AI Product Marketing Manager", "AI Product Manager", "Product Manager",
  "Brand Marketing Manager", "Senior Marketing Manager", "Marketing Manager",
  "Growth Marketing Manager", "Head of Marketing", "Director of Marketing",
];
export const LOCATIONS = [
  "remote", "anywhere", "global", "worldwide",
  "india", "pune", "mumbai", "bengaluru", "bangalore", "hyderabad", "delhi", "gurgaon", "gurugram", "noida",
]; // lowercase; empty job-location also passes (remote-friendly)
export const MIN_FIT = 65; // only surface roles scoring >= this

// Companies whose careers pages we watch, tagged by ATS. Auto-resolved from company names by
// resolve-slugs.js (edit companies.txt and re-run to add more; it probes the public APIs so you
// never hand-guess a slug). Greenhouse = boards.greenhouse.io/<slug>; Lever = jobs.lever.co/<slug>;
// Ashby = jobs.ashbyhq.com/<slug>.
export const GREENHOUSE = ["airtable", "algolia", "amplitude", "anthropic", "asana", "brex", "calendly", "cloudflare", "coinbase", "contentful", "cresta", "cultureamp", "databricks", "datadog", "descript", "discord", "dropbox", "elastic", "figma", "gitlab", "grafanalabs", "groww", "instacart", "intercom", "lattice", "mercury", "mixpanel", "mongodb", "netlify", "okta", "pendo", "phonepe", "pinterest", "postman", "reddit", "remote", "scaleai", "stripe", "togetherai", "twilio", "vercel", "webflow"];
export const LEVER = ["clari", "cred", "freshworks", "meesho", "mindtickle", "outreach", "zeta"];
export const ASHBY = ["1password", "atlan", "clickup", "cohere", "confluent", "deel", "elevenlabs", "harvey", "linear", "loom", "miro", "notion", "openai", "perplexity", "pinecone", "plaid", "ramp", "runway", "sanity", "sentry", "sierra", "snowflake", "synthesia", "writer", "zapier"];
