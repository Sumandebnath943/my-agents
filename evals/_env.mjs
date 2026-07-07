// evals/_env.mjs
// Import this FIRST in every eval (before any agent/lib import). Some agent modules construct a
// Supabase client at load time (e.g. agents/17-habits/handle.js), which calls env() and would
// throw without these vars. Constructing a client does NOT open a connection — no network happens
// unless a query method is called, and the evals never call one. Real .env values win (set first).
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = "http://localhost:54321";
if (!process.env.SUPABASE_KEY) process.env.SUPABASE_KEY = "eval-placeholder-key";
