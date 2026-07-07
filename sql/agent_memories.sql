-- sql/agent_memories.sql
-- Backing table for the Node-native adaptive memory layer (lib/memory.js). Agents remember
-- preferences/facts across runs and share them. The 768-dim embedding is stored as JSON and cosine
-- is computed in Node (same approach ECHO uses) — so NO pgvector extension is required.
--
-- Run once in the Supabase SQL editor (same project as the rest of the fleet). Memory is best-effort:
-- if this table is absent, agents simply run without memory (nothing breaks).

create table if not exists agent_memories (
  id         bigint generated always as identity primary key,
  scope      text        not null default 'user',   -- 'user' | 'agent' | 'session'
  scope_key  text        not null default 'suman',   -- e.g. 'suman', an agent name, or a session id
  content    text        not null,
  embedding  jsonb,                                   -- 768-dim vector as a JSON array
  source     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_memories_scope_idx on agent_memories (scope, scope_key, updated_at desc);
