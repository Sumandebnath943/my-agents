-- sql/tier_usage.sql
-- Backing table for the 🟡-tier ceiling framework (lib/tier.js). Tracks how many calls each
-- metered free add-on (Cohere, Firecrawl, Tavily, …) has used in the current billing period, so
-- agents degrade to their baseline path when the free budget is spent.
--
-- Run once in the Supabase SQL editor (same project as the rest of the fleet). The framework works
-- best-effort even without this table (tracking is simply skipped), but the dashboard tile needs it.

create table if not exists tier_usage (
  provider     text        not null,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  count        integer     not null default 0,
  ceiling      integer     not null,
  cadence      text        not null default 'calendar_month',
  status       text        not null default 'active',   -- 'active' | 'exhausted'
  updated_at   timestamptz not null default now(),
  primary key (provider, period_start)
);

create index if not exists tier_usage_provider_idx on tier_usage (provider, period_start desc);
