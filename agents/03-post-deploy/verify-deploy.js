// scripts/verify-deploy.js
// COPY THIS INTO THE PROJECT REPO you want guarded, at: scripts/verify-deploy.js
// (It runs inside that project's GitHub Actions on push — see verify-deploy.yml.)
const BASE = process.env.DEPLOY_URL;           // your live site URL
const ROUTES = ["/", "/api/health", "/login"]; // critical routes to verify
const EXPECT_OK = 200;

async function waitForFreshDeploy() {
  // Poll the homepage for up to 3 minutes so we test the NEW build, not the old one.
  for (let i = 0; i < 18; i++) {
    try {
      const res = await fetch(BASE, { cache: "no-store" });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 10000));
  }
}

await waitForFreshDeploy();

const failures = [];
for (const route of ROUTES) {
  try {
    const res = await fetch(BASE + route, { redirect: "follow" });
    if (res.status !== EXPECT_OK) failures.push(`${route} → ${res.status}`);
  } catch (e) {
    failures.push(`${route} → ${e.name}`);
  }
}

if (failures.length) {
  console.error("Broken routes:\n" + failures.join("\n"));
  // Tell Telegram (optional — needs the two secrets in THIS repo too)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `🔴 Deploy check failed:\n${failures.join("\n")}`,
      }),
    });
  }
  process.exit(1); // non-zero exit makes the GitHub Action open an issue (below)
}
console.log("All routes healthy after deploy ✅");
