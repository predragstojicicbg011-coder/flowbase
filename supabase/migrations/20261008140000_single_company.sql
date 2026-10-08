-- ============================================================================
-- One legal entity: Milinković Company doo
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
-- A fixed id, so running this twice adds nothing. Skipped as well when a
-- company of that name was already entered by hand.

insert into public.companies (id, name, country, currency, currencies)
select '6d1c0f5e-2a3b-4c7d-9e8f-000000000001', 'Milinković Company doo', 'Srbija', 'RSD', '{RSD,EUR}'
where not exists (select 1 from public.companies where name = 'Milinković Company doo')
on conflict (id) do nothing;


-- ── user_access ─────────────────────────────────────────────────────────────
-- Per-entity permissions keyed on a text entity name. Never read by the app:
-- access is `profiles.role` plus `profiles.company_access`, checked by
-- `has_company_access()`. No view, function or policy refers to it; its keys
-- and grants go with the table.

drop table if exists public.user_access;
