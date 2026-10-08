-- Nobody who is not signed in reaches anything in public.
--
-- The publishable key ships in the JS bundle, and PostgREST answers a request
-- without a session as `anon`. Mintflow closed nine tables to anon by hand
-- (payroll_records, payroll_lines, partners, import_logs and the P&L lookup
-- tables), so the schema dump carried no grant for them. But Supabase's
-- default privileges hand every table that `postgres` creates to anon, and
-- some of those tables have policies of `true` for role public. Rebuilt from
-- the dump, MCFlow had them open again: anyone holding the public key could
-- read salaries.
--
-- MCFlow has no page that works signed out (the login itself goes through
-- the auth API, not through these tables), so anon gets nothing at all,
-- now and for whatever is created later.

begin;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

commit;
