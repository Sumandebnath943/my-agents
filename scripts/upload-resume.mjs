// scripts/upload-resume.mjs — put your resume PDF in the private Supabase bucket.
//
// The apply driver runs in GitHub Actions and cannot see your Desktop, so the PDF has to live
// somewhere the runner can reach. It goes in the PRIVATE `job-agent` bucket — never in this repo,
// which is public, and never in a public bucket, because the file carries your contact details.
//
// Run locally, once (and again whenever you update the CV):
//   SUPABASE_URL=… SUPABASE_KEY=… node scripts/upload-resume.mjs "C:/path/to/Resume.pdf"
//
// Then set the RESUME_STORAGE_PATH secret to the path this prints (default: resume/resume.pdf).
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/upload-resume.mjs "<path to your resume.pdf>"');
  process.exit(1);
}
if (!/\.pdf$/i.test(file)) console.error("Warning: ATS forms want a PDF. Continuing anyway.");

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
if (!url || !key) { console.error("Set SUPABASE_URL and SUPABASE_KEY (the service key) in your environment."); process.exit(1); }

let buf, size;
try { buf = readFileSync(file); size = statSync(file).size; }
catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(1); }
if (!size) { console.error("That file is empty."); process.exit(1); }

const db = createClient(url, key);
const dest = process.env.RESUME_STORAGE_PATH || "resume/resume.pdf";

// The bucket is created by sql/jobs_apply.sql; create it here too so this script works standalone.
await db.storage.createBucket("job-agent", { public: false }).catch(() => {});

const { error } = await db.storage.from("job-agent").upload(dest, buf, {
  contentType: "application/pdf",
  upsert: true,
});
if (error) { console.error(`Upload failed: ${error.message}`); process.exit(1); }

console.log(`Uploaded ${basename(file)} (${(size / 1024).toFixed(0)} KB) -> job-agent/${dest}`);
console.log(`The bucket is PRIVATE. Set the RESUME_STORAGE_PATH secret to: ${dest}`);
