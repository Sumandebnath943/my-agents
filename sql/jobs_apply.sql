-- sql/jobs_apply.sql
-- Application state for the assisted-apply flow (Phase 2).
--
-- THE RULE THIS SCHEMA ENFORCES: nothing is ever submitted unattended.
-- The agent PREPARES an application — fills the form in a headless browser and screenshots it —
-- and then stops. A role can only move to 'submitting' from 'prepared', which means a human has
-- seen the filled form on the dashboard and pressed the button. `apply_state` is the interlock,
-- not a status label: agents/job-agent/apply/run.js refuses to submit anything not in 'prepared'.
--
-- Run once in the Supabase SQL editor, after sql/jobs_upgrade.sql. Idempotent.

alter table jobs add column if not exists apply_state       text not null default 'none';
alter table jobs add column if not exists apply_form        jsonb;        -- what we filled + what we couldn't answer
alter table jobs add column if not exists apply_receipt     jsonb;        -- confirmation text/url captured after submit
alter table jobs add column if not exists apply_error       text;
alter table jobs add column if not exists apply_shot        text;         -- Storage path of the filled-form screenshot
alter table jobs add column if not exists apply_prepared_at timestamptz;
alter table jobs add column if not exists apply_attempts    int not null default 0;

alter table jobs drop constraint if exists jobs_apply_state_check;
alter table jobs add constraint jobs_apply_state_check check (apply_state in (
  'none',         -- nothing attempted
  'preparing',    -- the browser run is in flight
  'prepared',     -- form filled + screenshotted, WAITING FOR A HUMAN
  'needs_input',  -- a required question has no canned answer — the agent will not guess
  'submitting',   -- approved by a human, submit run in flight
  'submitted',    -- confirmed sent
  'failed',       -- the run errored; apply_error says why
  'unsupported'   -- this ATS can't be driven reliably (apply by hand)
));

create index if not exists jobs_apply_state_idx on jobs (apply_state) where apply_state <> 'none';

-- --- Storage ------------------------------------------------------------------------------------
-- One PRIVATE bucket holds the resume PDF and the form screenshots. Private matters: the resume
-- carries personal contact details, and the screenshots show a filled-in application including
-- salary answers. Nothing here is ever world-readable; the dashboard serves signed URLs.
insert into storage.buckets (id, name, public)
values ('job-agent', 'job-agent', false)
on conflict (id) do nothing;

-- Only the service role touches this bucket (the agent writes, the dashboard signs). No anon policy
-- is created on purpose — the service key bypasses RLS, and adding an anon policy would be the
-- thing that accidentally makes a resume public.
