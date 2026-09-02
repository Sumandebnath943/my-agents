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
| `linkedin/` | no markdown leaks into published social posts; which of Suman's products a post names | `lib/email-template.js` `stripMarkdown`, `lib/profile.js` `projectsNamedIn` |
| `linkedin-slides/` | the PDF carousel: slide order, the per-slide source-similarity gate, provenance, determinism, the real text layer, and that the media flags agree across both workflows | `agents/10-linkedin/slides.js`, `agents/10-linkedin/carousel.js` |

## Add a case

- Routing: add a row to `routing/corpus.json` (`{ id, msg:{text,photoFileId}, expect }`).
- Others: add to the `cases` array in the suite's `run.mjs`.

## ⚠️ Green evals are not evidence the output is good

These suites guard **behaviour that must not regress**. They cannot tell you the output is any good,
because they run on fixtures someone invented — and invented fixtures are always tidier than real
data. `linkedin-slides/` sat at 100% while **15.4% of carousel slides built from real posts were
unreadable**: the four sample posts were self-contained sentences, and nothing Suman actually writes
looks like that.

Where a real corpus exists, measure against it as well. Two read-only audits do that for LinkedIn,
each printing its own pre-change baseline:

```bash
npm run audit:slides     # carousel slide quality across every published post
npm run audit:projects   # how often posts name a real product, and which ones
```

Neither is a build gate, and neither should become one — their heuristics deliberately over-report.
They are for answering "did this change make real output better or worse?", which no eval can.

## Add a suite

Create `evals/<name>/run.mjs` exporting `run()` (return an array of `runCases(...)` results), import
`../_env.mjs` **first** if it touches agent modules that build a Supabase client at load, then register
it in `run-all.mjs`. See `_lib.mjs` for `runCases`/`isMain`.
