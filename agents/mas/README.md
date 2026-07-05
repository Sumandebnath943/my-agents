# MAS — Multi-Agent System (isolated wing)

The MAS is a **walled-off** part of the Migi fleet. It orchestrates missions where multiple
agents plan, delegate, and collaborate — **manual-only**, **plan+propose (you approve every
action)**, and built so it can **never hamper** any scheduled agent's job, schedule, channels,
or data.

## Where the code lives
- **Brain (fast plane):** the Vercel dashboard app — `agents-dashboard/lib/mas/*` +
  `app/api/mas-telegram` (the MAS bot webhook) + `app/api/mas` + `app/dashboard/mas`.
- **Heavy steps (slow plane):** this folder — a MAS-only `workflow_dispatch` workflow
  (`.github/workflows/mas.yml`, added in build phase P4). **No cron.**

## Isolation contract
- Separate code · separate `workflow_dispatch`-only workflow (no cron) · separate Supabase
  tables (`mas_missions/mas_tasks/mas_messages/mas_memory`) + `mas:*` kv · separate Telegram
  bot (`MAS_BOT_TOKEN`) + dashboard tab · **separate LLM keys** (`MAS_GROQ_API_KEY` /
  `MAS_GEMINI_API_KEY`).
- Existing agents are used **read-only** or via **library reuse** inside MAS's own runtime.
  Any *approved* real trigger runs under a `MAS_RUN` flag that **redirects the output to MAS
  only** — scheduled runs never set that flag, so their behavior is unchanged.

## Build phases
- **P0 (done):** scaffolding — tables, MAS bot webhook, dashboard tab, libs.
- **P1:** Orchestrator + Critic + HITL approval + Mission #11 (Fleet Triage) end-to-end.
- **P2:** Researcher + external tools -> Market Scan (#7), Decision Memo (#8).
- **P3:** Memory/pgvector -> Ask Migi RAG (#9).
- **P4:** slow-plane Executor + `MAS_RUN` redirect -> Job War Room (#1), Content Engine (#4).
- **P5:** Voice agent (MAS bot + main bot).
- **P6:** dashboard polish + register MAS bot commands.

See `MAS_SETUP.md` (repo root, gitignored) for the one-time owner setup (keys, bot, SQL, env).
