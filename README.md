# Migi — an autonomous agent fleet

A personal fleet of **34 autonomous agents** that run on a schedule, entirely on free-tier
infrastructure. No servers, no containers, no paid orchestration layer — every agent is a
plain Node process invoked by a cron-scheduled GitHub Actions workflow, with Supabase as the
system of record.

Built and maintained by [Suman Debnath](https://github.com/Sumandebnath943).

> **Source-visible, not open source.** This code is published for portfolio and reference
> purposes. It is not licensed for reuse — see [License](#license).

---

## What it does

The fleet covers several domains, each agent owning one job and writing its results to a
shared Supabase schema:

| Domain | Agents |
|---|---|
| **Infrastructure** | uptime monitoring, Supabase keep-alive, deploy verification, dependency and expiry watch, self-healing, integrity checks |
| **Publishing** | LinkedIn drafting and recaps, build-in-public logs, launch drafts |
| **Personal ops** | daily briefing, calendar, journal, habits, expenses, finance ledger, read-later digests, notes and ideas capture |
| **Career** | job discovery and filtering, application assistance, skill-gap analysis, outreach scouting |
| **Meta** | standup, weekly review, team-manager (provider health and cost reporting), CTO and brand-manager reviews, housekeeping |

## Architecture

**Scheduling.** 48 workflows, ~34 of them cron-scheduled, spread across the day and budgeted to
about 53 scheduled events daily. Each is pinned to `contents: read` — no workflow in the fleet has
write access to the repository. Cadence is deliberately conservative: GitHub throttles
high-frequency `schedule` triggers, and a fleet that asks too often gets its dispatches delayed by
hours rather than rate-limited outright.

**Model routing.** Agents call a multi-provider layer spanning Groq, Gemini, Cerebras,
Mistral, OpenRouter and OpenAI, with automatic failover and rate-limit-aware pacing so the
fleet stays inside free-tier quotas. Every call is logged with provider, latency, status and
token counts, which feeds a weekly availability and cost report.

**Storage.** Supabase (Postgres + pgvector) holds all agent state, telemetry, and the
embedded document store used for retrieval.

**Delivery.** Results reach the operator over Telegram and email rather than a dashboard
that has to be checked.

**Evaluation.** The pure logic — routing, classification, parsing, filtering, reconciliation
— is extracted into side-effect-free functions with an offline eval suite (25 suites,
`npm run eval:all`) that runs on every pull request with no secrets and no network access.
Behaviour changes are caught by evals, not in production.

## Design principles

- **Free-tier or nothing.** Every dependency has a $0 path. Cost discipline is a design
  constraint, not an afterthought.
- **Degrade, never crash.** A missing table, a null column, or a dead provider must not stop
  the rest of the run. Agents are defensive about shape at every boundary.
- **Pure core, thin shell.** Decision logic is separated from I/O so it can be evaluated
  offline and deterministically.
- **Secrets never touch the repo.** All credentials are injected from GitHub Secrets at run
  time. Nothing sensitive has ever been committed to this history.

## Repository layout

```
agents/            one directory per agent
lib/               shared: model routing, env, metrics, storage, integrations
evals/             offline regression suites (no secrets, no network)
.github/workflows/ one workflow per agent, cron-scheduled
sql/               Supabase schema and migrations
scripts/           maintenance utilities
mcp/               MCP server exposing fleet tools
```

## Running it

You can't, and that's intentional — the fleet is bound to private Supabase tables, private
credentials, and one operator's data. There is no public deployment path, and none is
planned.

## License

Copyright © 2026 Suman Debnath. **All rights reserved.**

This repository is **source-visible, not open source**. Being able to read this code does not
grant permission to use it. Copying, redistributing, deploying, modifying, incorporating any
part of it into another project, or using it as machine-learning training data is **not
permitted** without prior written consent.

You may read it, and you may reference or quote limited portions with attribution.

Full terms: [LICENSE](LICENSE).
