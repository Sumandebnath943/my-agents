-- sql/habits_mood.sql
-- Adds an explicit 1-5 mood score to the daily habit log.
--
-- Mood already existed, but only as a WORD inferred from the evening journal brain-dump
-- ("tired", "good"). Words can't be correlated against sleep or productivity, so the one question
-- worth answering — does sleeping badly actually cost me anything? — was unanswerable. A number
-- alongside productivity makes it answerable. The journal's richer inferred mood stays untouched.
--
-- Nothing else changes: sleep_time/wake_time keep their existing shape, and sleep DURATION is
-- derived on read (agents/17-habits/analyze.js), so your entire back-history gains it retroactively
-- without a migration.
--
-- Run once in the Supabase SQL editor.

alter table habits add column if not exists mood integer;

-- One row per day. Logging sleep in the morning and mood at night should TOP UP the same row,
-- never create a second one that quietly halves every average.
create unique index if not exists habits_log_date_key on habits (log_date);

create index if not exists habits_log_date_desc_idx on habits (log_date desc);
