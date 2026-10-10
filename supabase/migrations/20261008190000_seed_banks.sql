-- The banks a client works with.
--
-- This migration used to insert the first client's ten banks. Migrations are
-- FlowBase's shared schema and carry no client data any more: the bank list
-- (with the ten banks most Serbian clients use as an optional block) lives in
-- the client's own supabase/client/seed.sql, made from
-- supabase/client/seed.example.sql and run with scripts/seed-client.sh.
-- Banks can also be added in Podešavanja → Banke. Databases where the old
-- insert already ran keep their rows.
--
-- The version stays so that databases which applied it see no change, and
-- the statement below only keeps the file from being empty.

select 1;
