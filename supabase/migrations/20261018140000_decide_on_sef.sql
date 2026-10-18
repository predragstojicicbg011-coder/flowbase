-- Deciding on SEF: accept or reject a supplier's invoice from the app.
--
-- Until now everything the inbox did stayed on our side, except the one fetch
-- that marks an invoice Seen. This adds the second thing that writes to SEF:
-- `purchase-invoice/acceptRejectPurchaseInvoice`. The supplier sees the
-- decision, the accounting firm sees it, and the law counts it:
--
--   * an ACCEPTED invoice is final -- the app never offers to reject it after;
--   * a REJECTED invoice may later be accepted, so that stays possible;
--   * a rejection must say why (SEF refuses one without a comment).
--
-- Only the `sef-decide` edge function talks to SEF, as service_role, after it
-- has checked that the caller keeps the books (`can_write_books()`) and that
-- the switch below is on. The browser cannot write any of the columns or rows
-- added here.
--
-- Three parts:
--
--   1. Columns on `sef_inbox` holding the decision that SEF accepted.
--   2. `sef_decisions`: every ATTEMPT, successful or not, append-only. A call
--      to SEF that failed, timed out or was refused is a fact somebody will
--      need in March ("did we try? what did SEF say?"), and the inbox row only
--      holds the one that worked.
--   3. A switch, `feature_flags.sef_decisions_enabled`, OFF by default. The
--      feature is a write to a government register; a client turns it on
--      deliberately, and only the administrator can.

begin;

-- ── 1. The decision on the inbox row ──────────────────────────────────────

alter table public.sef_inbox
  add column if not exists sef_decision          text,
  add column if not exists sef_decision_comment  text,
  add column if not exists sef_decided_at        timestamptz,
  add column if not exists sef_decided_by        uuid,
  -- The name as it stood when the decision was made. `profiles` is readable
  -- only by its own owner, so the screen could not otherwise say who decided.
  add column if not exists sef_decided_by_name   text,
  add column if not exists sef_decision_response jsonb;

alter table public.sef_inbox drop constraint if exists sef_inbox_sef_decision_known;
alter table public.sef_inbox add constraint sef_inbox_sef_decision_known
  check (sef_decision is null or sef_decision in ('accepted', 'rejected'));

-- A rejection on SEF always carries its reason; SEF refuses one without.
alter table public.sef_inbox drop constraint if exists sef_inbox_sef_rejection_says_why;
alter table public.sef_inbox add constraint sef_inbox_sef_rejection_says_why
  check (sef_decision is distinct from 'rejected'
         or btrim(coalesce(sef_decision_comment, '')) <> '');

-- Accepted is final. The edge function already refuses a second decision, but
-- it is not the only possible writer, and "final" that rests on one caller
-- remembering is not final.
create or replace function public.sef_inbox_guard_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.sef_decision = 'accepted'
     and new.sef_decision is distinct from old.sef_decision then
    raise exception 'Faktura je prihvaćena na SEF-u i ta odluka je konačna.';
  end if;
  return new;
end $$;

drop trigger if exists sef_inbox_guard_decision on public.sef_inbox;
create trigger sef_inbox_guard_decision
  before update of sef_decision on public.sef_inbox
  for each row execute function public.sef_inbox_guard_decision();

-- `grant select on table` (20261015100000) covers the new columns; the column
-- UPDATE grants there name only the four local-decision columns, so the
-- browser cannot write any of these.

-- ── 2. Every attempt, append-only ─────────────────────────────────────────

create table if not exists public.sef_decisions (
  id            uuid primary key default gen_random_uuid(),
  -- No cascade: an attempt recorded against SEF is not erased because a row
  -- or a company is. The delete is refused instead (the trigger below).
  inbox_id      uuid not null references public.sef_inbox (id),
  company_id    uuid not null references public.companies (id),
  accepted      boolean not null,
  comment       text,
  requested_by  uuid not null,
  requested_at  timestamptz not null default now(),
  -- Null when SEF was never reached (timeout, network): there was no answer.
  http_status   integer,
  success       boolean not null default false,
  sef_status    text,
  response      jsonb,
  error         text
);

create index if not exists sef_decisions_inbox_idx
  on public.sef_decisions (inbox_id, requested_at desc);

create or replace function public.sef_decisions_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'sef_decisions is append-only: an attempt on SEF is not changed or removed.';
end $$;

drop trigger if exists sef_decisions_append_only on public.sef_decisions;
create trigger sef_decisions_append_only
  before update or delete on public.sef_decisions
  for each row execute function public.sef_decisions_append_only();

-- TRUNCATE skips row triggers, so it gets its own.
drop trigger if exists sef_decisions_no_truncate on public.sef_decisions;
create trigger sef_decisions_no_truncate
  before truncate on public.sef_decisions
  for each statement execute function public.sef_decisions_append_only();

alter table public.sef_decisions enable row level security;

revoke all on table public.sef_decisions from anon, authenticated;
grant select on table public.sef_decisions to authenticated;
-- The edge function writes as service_role, which bypasses RLS.
grant select, insert on table public.sef_decisions to service_role;

drop policy if exists members_only on public.sef_decisions;
create policy members_only on public.sef_decisions as restrictive
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- Same predicate as `sef_inbox_read`. No insert, update or delete policy:
-- with RLS on, no policy means no access.
drop policy if exists sef_decisions_read on public.sef_decisions;
create policy sef_decisions_read
  on public.sef_decisions for select to authenticated using (public.is_member());

-- ── 3. The switch ─────────────────────────────────────────────────────────
--
-- In `feature_flags`, beside `period_lock`. Read by every member (the inbox
-- shows the buttons disabled and says why), written by `feature_flags_write`,
-- which already requires `is_admin()`. `do nothing` so that re-running this
-- never turns off a switch a client has turned on.

insert into public.feature_flags (name, enabled)
values ('sef_decisions_enabled', false)
on conflict (name) do nothing;

-- `is_admin()` also admits the owner. This switch is narrower: the
-- administrator, the same person the Settings screen shows it to. A write
-- with no signed-in user (service_role, the SQL editor) is the operator and
-- is let through.
create or replace function public.feature_flags_guard_sef_decisions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.name = 'sef_decisions_enabled' or old.name = 'sef_decisions_enabled' then
    if auth.uid() is not null and not exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.role = 'administrator'
    ) then
      raise exception 'Odlučivanje na SEF-u uključuje i isključuje samo administrator.';
    end if;
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists feature_flags_guard_sef_decisions on public.feature_flags;
create trigger feature_flags_guard_sef_decisions
  before update on public.feature_flags
  for each row execute function public.feature_flags_guard_sef_decisions();

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sef_decisions'
       and policyname = 'members_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'sef_decisions is missing its members_only policy';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sef_decisions'
       and cmd <> 'SELECT' and permissive = 'PERMISSIVE'
  ) then
    raise exception 'sef_decisions has a policy that lets the browser write';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon'
       and table_name in ('sef_inbox', 'sef_decisions')
  ) then
    raise exception 'anon was granted rights on the SEF tables';
  end if;

  if has_table_privilege('authenticated', 'public.sef_decisions', 'INSERT')
     or has_table_privilege('authenticated', 'public.sef_decisions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.sef_decisions', 'DELETE') then
    raise exception 'the browser can write sef_decisions';
  end if;

  if has_column_privilege('authenticated', 'public.sef_inbox', 'sef_decision', 'UPDATE')
     or has_column_privilege('authenticated', 'public.sef_inbox', 'sef_decided_by', 'UPDATE')
     or has_column_privilege('authenticated', 'public.sef_inbox', 'sef_status', 'UPDATE') then
    raise exception 'the decision on SEF can be written from the browser';
  end if;

  if not exists (select 1 from public.feature_flags where name = 'sef_decisions_enabled') then
    raise exception 'the sef_decisions_enabled switch is missing';
  end if;
end $$;

commit;
