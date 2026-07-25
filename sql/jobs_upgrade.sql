-- sql/jobs_upgrade.sql
-- Brings the `jobs` table up to what the rebuilt Job Agent produces and what the Jobs dashboard
-- needs for triage. The table was created ad-hoc and had no migration file; this is now it.
--
-- TWO IDEAS DRIVE THE SHAPE HERE:
--
-- 1. Pipeline status and "why I dropped it" are DIFFERENT THINGS. "irrelevant" and "job post
--    deleted" are not stages of an application — they are reasons for leaving the pipeline. So
--    `status` stays a clean funnel and `dismiss_reason` records the exit cause. Cramming both into
--    one enum makes "how many did I actually apply to?" unanswerable.
--
-- 2. Dismissal reasons are TRAINING DATA. Every role marked `irrelevant` or `location_mismatch` is
--    a labelled example of the filter getting it wrong, which is what feeds new eval cases and
--    exclusion rules. That is why the reason is a constrained vocabulary and not free text.
--
-- Run once in the Supabase SQL editor. Every statement is idempotent — re-running is harmless.

-- --- What the agent's screen learned about each role -------------------------------------------
alter table jobs add column if not exists source          text;          -- greenhouse | lever | ashby | naukri | linkedin | …
alter table jobs add column if not exists family          text;          -- pmm | ai | pm | growth_brand
alter table jobs add column if not exists geo_class       text;          -- india_onsite | india_remote | global_remote | foreign | unknown
alter table jobs add column if not exists geo_reason      text;          -- why the geo gate decided that
alter table jobs add column if not exists posted_at       timestamptz;   -- when the EMPLOYER posted it (null = source didn't say)
alter table jobs add column if not exists salary_text     text;          -- raw pay string as published
alter table jobs add column if not exists salary_min_lpa  numeric(8,2);  -- parsed, INR lakhs per annum
alter table jobs add column if not exists salary_max_lpa  numeric(8,2);
alter table jobs add column if not exists flags           jsonb default '[]'::jsonb;  -- ["comp undisclosed","wants US/EU working hours"]
alter table jobs add column if not exists why_matched     text;          -- the screen's own explanation

-- --- What the scorer said ----------------------------------------------------------------------
alter table jobs add column if not exists seniority_match text;          -- under | match | over
alter table jobs add column if not exists why_not         text;          -- biggest gap, for sub-threshold roles
alter table jobs add column if not exists emphasize       text;
alter table jobs add column if not exists fit_reasons     text;

-- --- Triage + pipeline -------------------------------------------------------------------------
alter table jobs add column if not exists dismiss_reason  text;          -- see the vocabulary below
alter table jobs add column if not exists dismissed_at    timestamptz;
alter table jobs add column if not exists applied_at      timestamptz;
alter table jobs add column if not exists notes           text;
alter table jobs add column if not exists updated_at      timestamptz default now();

-- --- Status vocabulary -------------------------------------------------------------------------
-- The old set was: new | applied | interviewing | rejected | skipped.
-- A CHECK constraint on `status` (under any name) would reject the new values, so drop whatever
-- constraint currently guards the column before installing the new one. Named constraints differ
-- between hand-created tables, hence the catalogue lookup rather than a hardcoded name.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where rel.relname = 'jobs' and ns.nspname = 'public' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  loop
    execute format('alter table jobs drop constraint %I', c.conname);
  end loop;
end $$;

-- Migrate the one legacy value that no longer exists in the funnel. 'skipped' was doing the job
-- that `dismiss_reason` now does properly, so preserve the intent rather than dropping it.
update jobs set status = 'dismissed', dismiss_reason = coalesce(dismiss_reason, 'not_interested')
where status = 'skipped';

alter table jobs alter column status set default 'new';
alter table jobs add constraint jobs_status_check check (status in (
  'new',            -- surfaced, not yet triaged
  'shortlisted',    -- worth applying to
  'applied',
  'screening',      -- recruiter screen / assignment
  'interviewing',
  'offer',
  'rejected',       -- THEY said no
  'dismissed',      -- I said no (see dismiss_reason)
  'closed'          -- ended for any other reason
));

alter table jobs add constraint jobs_dismiss_reason_check check (dismiss_reason is null or dismiss_reason in (
  'irrelevant',           -- wrong kind of role for me
  'location_mismatch',    -- not actually India-eligible → the geo gate missed one
  'comp_too_low',
  'seniority_mismatch',   -- too junior or too senior
  'post_deleted',         -- listing is gone / expired
  'duplicate',
  'company_blocked',      -- never want this employer
  'not_interested',
  'already_applied',      -- found it through another source
  'ghosted'               -- applied, never heard back
));

-- --- Indexes -----------------------------------------------------------------------------------
create index if not exists jobs_status_fit_idx    on jobs (status, fit desc nulls last);
create index if not exists jobs_created_idx       on jobs (created_at desc);
create index if not exists jobs_posted_idx        on jobs (posted_at desc nulls last);
create index if not exists jobs_geo_idx           on jobs (geo_class);
create index if not exists jobs_source_idx        on jobs (source);
create index if not exists jobs_dismiss_idx       on jobs (dismiss_reason) where dismiss_reason is not null;
create unique index if not exists jobs_hash_idx   on jobs (job_hash);

-- --- Keep updated_at honest --------------------------------------------------------------------
create or replace function jobs_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  -- Stamp the moment a role enters a terminal-ish state, so the dashboard can show "applied 3d ago"
  -- without a separate events table.
  if new.status = 'applied' and coalesce(old.status, '') <> 'applied' and new.applied_at is null then
    new.applied_at = now();
  end if;
  if new.status = 'dismissed' and coalesce(old.status, '') <> 'dismissed' and new.dismissed_at is null then
    new.dismissed_at = now();
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs
for each row execute function jobs_touch_updated_at();

-- --- What the filter is throwing away ----------------------------------------------------------
-- Every dismissal is a labelled example of the screen being wrong. This view is the shortlist of
-- rules worth adding to agents/job-agent/config.js (and cases worth adding to evals/job-filter).
create or replace view jobs_filter_feedback as
select dismiss_reason,
       count(*)                                     as n,
       count(distinct company)                      as companies,
       round(avg(fit))                              as avg_fit,
       array_agg(distinct company order by company) filter (where company is not null) as company_list,
       max(dismissed_at)                            as last_seen
from jobs
where dismiss_reason is not null
group by dismiss_reason
order by n desc;
