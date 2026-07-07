# Evals — offline regression gate

Pure, offline checks on the fleet's critical logic. **No secrets, no network, no LLM calls** — every
case resolves by rule, so these run on every PR (`.github/workflows/evals.yml`) and locally in <1s.

Modeled on the dashboard's `scripts/finance-eval.mjs` (43/43). The **finance** classifier and its eval
live in the **agents-dashboard** repo (`lib/finance/classify.js` + `scripts/finance-eval.mjs`) — not
duplicated here.

## Run

```bash
npm run eval:all        # all suites, exits 1 on any failure
npm run eval:routing    # inbox routing decision + windowDays() + /command registry
npm run eval:json       # parseJson() fence-stripping
npm run eval:linkedin   # stripMarkdown() no-leak (social posts render literal text)
npm run check           # node --check on the touched source files
```

## Suites

| Suite | Guards | Real code under test |
|---|---|---|
| `routing/` | which handler an inbound Telegram message goes to | `agents/inbox-router/route.js` `classifyRoute`, `commands.js` `windowDays`/`COMMANDS` |
| `json/` | recovering JSON from fenced LLM output | `lib/llm.js` `parseJson` |
| `linkedin/` | no markdown leaks into published social posts | `lib/email-template.js` `stripMarkdown` |

## Add a case

- Routing: add a row to `routing/corpus.json` (`{ id, msg:{text,photoFileId}, expect }`).
- Others: add to the `cases` array in the suite's `run.mjs`.

## Add a suite

Create `evals/<name>/run.mjs` exporting `run()` (return an array of `runCases(...)` results), import
`../_env.mjs` **first** if it touches agent modules that build a Supabase client at load, then register
it in `run-all.mjs`. See `_lib.mjs` for `runCases`/`isMain`.
