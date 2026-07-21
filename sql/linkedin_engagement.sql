-- sql/linkedin_engagement.sql
-- Engagement history for published LinkedIn posts. The Sunday recap (agents/10-linkedin/10d-recap.js)
-- already fetched likes/comments from LinkedIn's socialActions API, emailed them, and threw them
-- away — so the agent that WRITES the next post had no idea which of the previous ones worked.
-- This table keeps the numbers so the writer can eventually learn from its own winners.
--
-- Append-only SAMPLES, not one row per post: LinkedIn engagement keeps accruing for days after
-- publishing, so a single reading taken the day after posting is meaningless for ranking. The recap
-- re-samples every post from the last ~45 days each week; `post_age_days` lets you compare
-- like-for-like (e.g. "likes at ~14 days old") instead of comparing a fresh post to a mature one.
--
-- Run once in the Supabase SQL editor (same project as the rest of the fleet). Persistence is
-- best-effort: without this table the recap email still sends exactly as before.

create table if not exists linkedin_engagement (
  id            bigint generated always as identity primary key,
  post_id       bigint      references linkedin_posts(id) on delete cascade,
  post_urn      text,                                  -- the urn:li:… id the sample was read from
  likes         integer,                               -- null = LinkedIn did not expose it
  comments      integer,
  post_age_days integer,                               -- age of the post when this sample was taken
  sampled_at    timestamptz not null default now()
);

create index if not exists linkedin_engagement_post_idx    on linkedin_engagement (post_id, sampled_at desc);
create index if not exists linkedin_engagement_sampled_idx on linkedin_engagement (sampled_at desc);

-- Latest sample per post, with the post's headline — the shape Phase 3's "learn from my winners"
-- step will read. Created as a view so that logic lives in one place.
create or replace view linkedin_post_performance as
select distinct on (e.post_id)
  e.post_id, p.headline, p.post_url, p.created_at as posted_at,
  e.likes, e.comments, e.post_age_days, e.sampled_at,
  coalesce(e.likes, 0) + 2 * coalesce(e.comments, 0) as engagement_score
from linkedin_engagement e
join linkedin_posts p on p.id = e.post_id
order by e.post_id, e.sampled_at desc;
