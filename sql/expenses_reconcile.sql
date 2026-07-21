-- sql/expenses_reconcile.sql
-- Links receipt photos (`expenses`, agent #16) to the SMS bank ledger (`finance`, agent #20).
--
-- The two spend systems were completely disjoint: photograph a bill AND get the bank SMS for the
-- same purchase, and it landed twice as two unrelated records. These columns record which bank
-- debit a receipt belongs to.
--
-- IMPORTANT — this does NOT change what is counted. The owner policy stands: the ledger logs
-- DEBITS ONLY, the bank SMS is the source of truth, and the weekly review sums `finance` alone.
-- A receipt can only ENRICH a matched debit; it never creates a transaction, so totals can never
-- inflate. A receipt with no bank match is flagged `unmatched` for review, not added.
--
-- Run once in the Supabase SQL editor. Reconciliation is best-effort: without these columns the
-- receipt and ledger agents behave exactly as they did before.

alter table expenses add column if not exists finance_id   bigint references finance(id) on delete set null;
alter table expenses add column if not exists match_status text not null default 'pending';  -- pending | linked | unmatched | ambiguous
alter table expenses add column if not exists matched_at   timestamptz;

create index if not exists expenses_match_status_idx on expenses (match_status, spent_on desc);
create index if not exists expenses_finance_id_idx   on expenses (finance_id);

-- Receipts still waiting on (or missing) a bank debit — what the dashboard surfaces for review.
create or replace view expenses_needing_review as
select e.id, e.merchant, e.amount, e.currency, e.category, e.spent_on, e.match_status, e.created_at
from expenses e
where e.match_status in ('unmatched', 'ambiguous')
order by e.spent_on desc;
