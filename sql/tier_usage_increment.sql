-- sql/tier_usage_increment.sql
-- ATOMIC increment for the 🟡-tier counters (lib/tier.js bump()).
--
-- Why this exists: bump() previously did read-modify-write from JavaScript — SELECT the count, add
-- one, UPSERT it back. Two workflows running at the same time both read N and both write N+1, so
-- one call vanishes. That was invisible while a separate bug pinned every counter at 1; now that
-- counts actually climb, the race is the next thing that would make the numbers lie.
--
-- Doing the read and the write in ONE statement inside Postgres makes concurrent increments safe:
-- `count = tier_usage.count + 1` is evaluated by the database against the current row, under a lock.
--
-- OPTIONAL. lib/tier.js calls this RPC and falls back to the old read-modify-write if the function
-- is absent, so the fleet works with or without it (enhancement, never dependency). Run it in the
-- Supabase SQL editor for the same project as sql/tier_usage.sql to get exact counts.

create or replace function tier_usage_increment(
  p_provider     text,
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_ceiling      integer,
  p_cadence      text
) returns integer
language plpgsql
as $$
declare
  new_count integer;
begin
  insert into tier_usage (provider, period_start, period_end, count, ceiling, cadence, status, updated_at)
  values (
    p_provider, p_period_start, p_period_end, 1, p_ceiling, p_cadence,
    case when 1 >= p_ceiling then 'exhausted' else 'active' end, now()
  )
  on conflict (provider, period_start) do update
    set count      = tier_usage.count + 1,
        ceiling    = excluded.ceiling,
        cadence    = excluded.cadence,
        period_end = excluded.period_end,
        status     = case when tier_usage.count + 1 >= excluded.ceiling then 'exhausted' else 'active' end,
        updated_at = now()
  returning count into new_count;

  return new_count;
end;
$$;
