-- sql/apply_answers.sql
-- Answers you type once, reused forever.
--
-- The agent refuses to invent answers, so an unfamiliar required question blocks the application.
-- Without this table your only remedy is editing a GitHub secret, which is a miserable loop. Now
-- the blocked question appears on the dashboard with a text box; what you type lands here and is
-- matched against future forms by NORMALIZED label, so the agent gets blocked less over time.
--
-- Matching is on `label_norm` (see normalizeLabel() in agents/job-agent/apply/forms.js), which
-- strips required-markers, parentheticals and filler words — so "Expected CTC*",
-- "Expected CTC (per annum)" and "What is your expected CTC?" all resolve to one row.
--
-- NOTE this table can hold personal answers (salary figures, notice period). It is service-role
-- only, exactly like the rest of the schema — never exposed to an anon key.
--
-- Run once in the Supabase SQL editor. Idempotent.

create table if not exists apply_answers (
  id           bigserial primary key,
  label_norm   text not null unique,     -- the matching key
  label        text not null,            -- the question as the form actually worded it
  answer       text not null,
  source       text not null default 'dashboard',  -- dashboard | secret | llm_draft
  times_used   int  not null default 0,
  first_seen   text,                     -- which role surfaced this question first (title @ company)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists apply_answers_used_idx on apply_answers (times_used desc);

create or replace function apply_answers_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists apply_answers_touched on apply_answers;
create trigger apply_answers_touched before update on apply_answers
for each row execute function apply_answers_touch();
