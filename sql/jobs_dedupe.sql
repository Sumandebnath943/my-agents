-- sql/jobs_dedupe.sql
-- Content fingerprint, so one job is one row no matter how many sites advertise it.
--
-- `job_hash` is a hash of the URL. That was sufficient while every role came from a company's own
-- ATS board — one job, one URL. With nine job portals added, the same role arrives from Naukri,
-- LinkedIn and the company careers page at three different URLs, and URL-hashing sees three jobs.
-- `fingerprint` is company + title + canonical city (see agents/job-agent/dedupe.js), which is the
-- same for all three.
--
-- NOT a unique constraint, deliberately: a fingerprint can legitimately repeat when a company
-- reposts a role months later, and a hard constraint would make the agent crash rather than skip.
-- The agent checks it before inserting; this index just makes that check fast.
--
-- Run once in the Supabase SQL editor. Idempotent. Existing rows get no fingerprint until they are
-- next seen, which is fine — they already exist and won't be re-inserted anyway.

alter table jobs add column if not exists fingerprint text;

create index if not exists jobs_fingerprint_idx on jobs (fingerprint) where fingerprint is not null;

-- Which roles are already duplicated in the table? Useful once, to see what the old URL-only
-- dedupe let through before this shipped.
create or replace view jobs_duplicates as
select fingerprint,
       count(*)                                as copies,
       array_agg(distinct coalesce(source, ats)) as sources,
       min(title)                              as title,
       min(company)                            as company,
       array_agg(id order by id)               as ids
from jobs
where fingerprint is not null
group by fingerprint
having count(*) > 1
order by count(*) desc;
