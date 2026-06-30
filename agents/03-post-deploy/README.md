# Agent #3 — Post-Deploy Verifier (per-project, on push)

Unlike the other agents, this one does **not** run from the `my-agents` repo. It is a
copy-paste pair you install **inside each project repo** you want guarded. It fires on
every push to `main`, waits for the new deploy, checks your critical routes on the live
site, and if anything broke it **opens a GitHub issue** and (optionally) **pings Telegram**.

This works only for projects whose repo is on GitHub **and** that deploy from a push to
`main` (e.g. Vercel/Netlify/Railway auto-deploy from GitHub). A site hosted by uploading
files manually (no GitHub-triggered deploy) can't use the on-push trigger.

## Install into a project repo (per project)

1. Copy [`verify-deploy.js`](./verify-deploy.js) into that repo at **`scripts/verify-deploy.js`**.
2. Copy [`verify-deploy.yml`](./verify-deploy.yml) into that repo at **`.github/workflows/verify-deploy.yml`**.
3. Edit two things for that project:
   - In the workflow, set `DEPLOY_URL:` to the project's live URL.
   - In `scripts/verify-deploy.js`, set `ROUTES` to that project's critical paths
     (e.g. `["/", "/pricing", "/api/health"]`). Use routes that should return **200**.
4. (Optional Telegram) Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as secrets in
   **that** repo (Settings → Secrets and variables → Actions). Without them you still get
   the GitHub issue; you just skip the Telegram ping.
5. Commit + push to `main`. Watch the **Actions** tab of that project.

## Notes
- `GITHUB_TOKEN` is provided automatically inside Actions — no PAT needed to open the
  issue. The `permissions: issues: write` line in the workflow is required, though.
- The 3-minute homepage poll handles normal build delays (incl. Vercel previews). For
  slow builds, raise the loop count in `waitForFreshDeploy()`.
- To test the failure path, temporarily add a route you know 404s to `ROUTES` and push.
