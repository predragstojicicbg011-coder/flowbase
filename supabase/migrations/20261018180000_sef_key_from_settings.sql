-- The SEF key is entered in the app, and the app can never read it back.
--
-- Until now the SEF API key had to be typed into `integration_credentials` by
-- hand. This gives the administrator a way to set it from Podešavanja → SEF,
-- and at the same time closes the table to the browser altogether:
--
--   * sef_set_api_key(key, environment[, company])  administrator (is_admin():
--       'administrator' or 'owner' — the same test the table's own policy
--       has used since 20261015090000) writes the single SEF row.
--   * sef_key_status()  every member sees WHETHER a key is set, which server
--       it points at, its last four characters, and who set it when. Never
--       the key.
--   * `authenticated` loses every privilege on the table, column by column
--       included. Nothing in src reads it; the edge functions reach it as
--       service_role, which keeps everything. Not even an administrator can
--       select `api_key` through PostgREST any more.
--
-- THE CONVENTION THE EDGE FUNCTIONS ALREADY READ (sef-pull, sef-fetch-invoice,
-- sef-decide): one row with provider = 'sef' and is_active = true; the key in
-- `api_key`; `extra.base_url` overrides the server, absent meaning production
-- (https://efaktura.mfin.gov.rs/api/publicApi); `extra.company_id` names the
-- company the pulled invoices are filed under (sef-pull refuses without it).
-- The demo server is the same path on demoefaktura.mfin.gov.rs.
--
-- WHO SET IT is kept twice over, and the key never is: `key_set_by` and
-- `key_set_at` on the row answer the status line, and every save adds a row
-- to `audit_log` (append-only for signed-in accounts: insert, and select for
-- the administrator; no update or delete policy) carrying the environment and
-- the company — not the key, not even its last four characters.

begin;

-- ── Who set it ────────────────────────────────────────────────────────────

alter table public.integration_credentials
  add column if not exists key_set_by uuid references auth.users (id) on delete set null,
  add column if not exists key_set_at timestamptz;

comment on column public.integration_credentials.key_set_by is
  'Who last saved the key through sef_set_api_key. The history is in audit_log.';
comment on column public.integration_credentials.key_set_at is
  'When the key was last saved through sef_set_api_key.';

-- ── The browser never reads a secret ──────────────────────────────────────
--
-- Table-level REVOKE also takes away any column-level grant. Writes go too:
-- the only way in is sef_set_api_key, which validates what it stores.

revoke all on table public.integration_credentials from authenticated, anon, public;
grant  all on table public.integration_credentials to service_role;

-- ── Setting the key ───────────────────────────────────────────────────────

create or replace function public.sef_set_api_key(
  p_api_key     text,
  p_environment text,
  p_company_id  uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  k          text := btrim(coalesce(p_api_key, ''));
  env        text := lower(btrim(coalesce(p_environment, '')));
  row_id     uuid;
  row_extra  jsonb;
  company    uuid;
  n          integer;
begin
  if not public.is_admin() then
    raise exception 'SEF API ključ podešava samo administrator.'
      using errcode = 'insufficient_privilege';
  end if;

  if k = '' then
    raise exception 'Unesite SEF API ključ.' using errcode = 'invalid_parameter_value';
  end if;
  -- SEF issues keys as UUIDs (e.g. 462d9282-22cf-4d0b-afbe-17411d375a18).
  -- Anything else is a paste of the wrong thing, and SEF would only say 401.
  if k !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' then
    raise exception 'To ne liči na SEF API ključ (očekuje se oblik 462d9282-22cf-4d0b-afbe-17411d375a18).'
      using errcode = 'invalid_parameter_value';
  end if;
  if env not in ('production', 'demo') then
    raise exception 'Okruženje mora biti produkcija ili demo.' using errcode = 'invalid_parameter_value';
  end if;

  -- One save at a time, so two administrators cannot leave two active rows.
  perform pg_advisory_xact_lock(hashtext('public.sef_set_api_key'));

  select id, coalesce(extra, '{}'::jsonb) into row_id, row_extra
    from public.integration_credentials
   where provider = 'sef'
   order by is_active desc nulls last, updated_at desc nulls last
   limit 1
   for update;

  -- Which company the pulled invoices are filed under: the one asked for, or
  -- the one the row already names, or — when there is only one — that one.
  if p_company_id is not null then
    if not exists (select 1 from public.companies where id = p_company_id)
       or not public.has_company_access(p_company_id) then
      raise exception 'Ta firma ne postoji ili joj nemate pristup.'
        using errcode = 'invalid_parameter_value';
    end if;
    company := p_company_id;
  elsif row_extra ? 'company_id'
        and exists (select 1 from public.companies where id::text = row_extra->>'company_id') then
    company := (row_extra->>'company_id')::uuid;
  else
    select count(*) into n from public.companies;
    if n = 1 then
      select id into company from public.companies;
    else
      raise exception 'Izaberite firmu kojoj ključ pripada.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  row_extra := coalesce(row_extra, '{}'::jsonb) - 'base_url'
               || jsonb_build_object('company_id', company);
  if env = 'demo' then
    row_extra := row_extra || jsonb_build_object('base_url', 'https://demoefaktura.mfin.gov.rs/api/publicApi');
  end if;

  if row_id is null then
    insert into public.integration_credentials
      (provider, api_key, extra, is_active, created_at, updated_at, key_set_by, key_set_at)
    values
      ('sef', k, row_extra, true, now(), now(), auth.uid(), now())
    returning id into row_id;
  else
    update public.integration_credentials
       set api_key = k, extra = row_extra, is_active = true,
           updated_at = now(), key_set_by = auth.uid(), key_set_at = now()
     where id = row_id;
  end if;

  -- The edge functions take the first active SEF row; there must be one.
  update public.integration_credentials
     set is_active = false, updated_at = now()
   where provider = 'sef' and id <> row_id and is_active;

  insert into public.audit_log (user_id, user_email, action, table_name, record_id, old_data, new_data)
  values (
    auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    'SEF_KEY_SET', 'integration_credentials', row_id, null,
    jsonb_build_object('provider', 'sef', 'environment', env, 'company_id', company)
  );
end
$$;

comment on function public.sef_set_api_key(text, text, uuid) is
  'Saves the SEF API key (administrator only). The key cannot be read back.';

-- ── What a member may know about it ───────────────────────────────────────

create or replace function public.sef_key_status()
returns table (
  configured   boolean,
  environment  text,
  last4        text,
  set_at       timestamptz,
  set_by_name  text,
  company_id   uuid,
  company_name text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  if not public.is_member() then
    raise exception 'Samo članovi firme vide stanje SEF ključa.'
      using errcode = 'insufficient_privilege';
  end if;

  select ic.api_key, ic.extra, ic.key_set_at, ic.updated_at, ic.key_set_by
    into r
    from public.integration_credentials ic
   where ic.provider = 'sef' and ic.is_active
   order by ic.updated_at desc nulls last
   limit 1;

  if not found or coalesce(btrim(r.api_key), '') = '' then
    configured := false;
    return next;
    return;
  end if;

  configured  := true;
  environment := case
    when coalesce(r.extra->>'base_url', '') = '' then 'production'
    when r.extra->>'base_url' ilike '%demoefaktura%' then 'demo'
    else 'other'
  end;
  last4       := right(btrim(r.api_key), 4);
  set_at      := coalesce(r.key_set_at, r.updated_at);
  set_by_name := (select coalesce(nullif(btrim(p.full_name), ''), p.email)
                    from public.profiles p where p.id = r.key_set_by);
  company_id  := case when (r.extra->>'company_id') ~* '^[0-9a-f-]{36}$'
                      then (r.extra->>'company_id')::uuid end;
  company_name := (select c.name from public.companies c where c.id = company_id);
  return next;
end
$$;

comment on function public.sef_key_status() is
  'Whether a SEF key is set, where it points, its last four characters and who set it. Never the key.';

revoke all on function public.sef_set_api_key(text, text, uuid) from public, anon;
revoke all on function public.sef_key_status()                 from public, anon;
grant execute on function public.sef_set_api_key(text, text, uuid) to authenticated;
grant execute on function public.sef_key_status()                 to authenticated, service_role;

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
declare
  c text;
begin
  if has_table_privilege('authenticated', 'public.integration_credentials', 'select')
     or has_table_privilege('authenticated', 'public.integration_credentials', 'insert')
     or has_table_privilege('authenticated', 'public.integration_credentials', 'update')
     or has_table_privilege('authenticated', 'public.integration_credentials', 'delete') then
    raise exception 'signed-in accounts can still reach integration_credentials directly';
  end if;
  foreach c in array array['api_key', 'api_secret', 'extra', 'merchant_id'] loop
    if has_column_privilege('authenticated', 'public.integration_credentials', c, 'select') then
      raise exception 'signed-in accounts can still read integration_credentials.%', c;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.integration_credentials', 'select') then
    raise exception 'anon can read integration_credentials';
  end if;
  if not has_table_privilege('service_role', 'public.integration_credentials', 'select')
     or not has_column_privilege('service_role', 'public.integration_credentials', 'api_key', 'select') then
    raise exception 'the edge functions (service_role) can no longer read the SEF key';
  end if;

  if has_function_privilege('anon', 'public.sef_set_api_key(text, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.sef_key_status()', 'execute') then
    raise exception 'anon may call the SEF key functions';
  end if;
  if (select prosrc from pg_proc where proname = 'sef_set_api_key'
        and pronamespace = 'public'::regnamespace) !~ 'is_admin\(\)' then
    raise exception 'sef_set_api_key does not check the caller';
  end if;
  if (select prosrc from pg_proc where proname = 'sef_key_status'
        and pronamespace = 'public'::regnamespace) !~ 'is_member\(\)' then
    raise exception 'sef_key_status does not check the caller';
  end if;

  -- Here auth.uid() is null, which is nobody: both must refuse, and the
  -- refusal must come before anything is read or written.
  begin
    perform public.sef_set_api_key('462d9282-22cf-4d0b-afbe-17411d375a18', 'demo');
    raise exception 'sef_set_api_key let a caller who is not an administrator through';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.sef_key_status();
    raise exception 'sef_key_status answered a caller who is not a member';
  exception when insufficient_privilege then
    null;
  end;
end $$;

commit;
