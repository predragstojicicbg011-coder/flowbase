-- ============================================================================
-- One legal entity per client app
--
-- The `companies` table and every `company_id` stay. This code is also the
-- starting point for clients with several entities; the app shows no company
-- picker while there is only one company, and uses that one everywhere.
--
-- `groups` is not needed: `companies.group_id` is nullable, and nothing in
-- the app reads groups.
--
-- No CASCADE: an unknown dependency fails the migration instead of vanishing.
-- ============================================================================


-- ── The company ─────────────────────────────────────────────────────────────
-- This migration used to insert the first client's company row. Migrations
-- are FlowBase's shared schema and carry no client data any more: the
-- company row (name, currency RSD, currencies {RSD,EUR}) is written by the
-- client's own supabase/client/seed.sql, made from
-- supabase/client/seed.example.sql and run with scripts/seed-client.sh.
-- Databases where the old insert already ran keep their row.


-- ── user_access ─────────────────────────────────────────────────────────────
-- Per-entity permissions keyed on a text entity name. Never read by the app:
-- access is `profiles.role` plus `profiles.company_access`, checked by
-- `has_company_access()`. No view, function or policy refers to it; its keys
-- and grants go with the table.

drop table if exists public.user_access;
