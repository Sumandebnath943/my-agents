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

// Companies whose careers pages you want watched, tagged by ATS. These are working EXAMPLE
// slugs so the agent runs on day one — replace with your real targets (Suman: send me a list
// and I'll resolve slugs). Greenhouse token = boards.greenhouse.io/<token>; Lever site =
// jobs.lever.co/<site>; Ashby name = jobs.ashbyhq.com/<name>.
export const GREENHOUSE = ["stripe", "figma", "notion"];
export const LEVER = ["netflix"];
export const ASHBY = ["openai", "ramp", "linear"];
