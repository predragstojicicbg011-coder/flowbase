-- Tests for 20261019120000_invoice_documents_uploaded.sql.
--
-- How to run: in ONE transaction that is rolled back, with the migration
-- (begin/commit stripped) in front when the database does not have it yet:
--
--   begin;
--   \i <migration without begin/commit, if not applied>
--   \i supabase/tests/invoice_documents_test.sql
--   rollback;
--
-- Safe on a live database: it only creates fixtures (a company "Test dokumenti
-- (TEST-DOCS)", users 0d0c0000-..., one invoice) and always ends in the
-- rollback. Must run as the database owner. Ends with ALL TESTS PASSED.
--
-- Actors: f1 finance (administrator), f2 manager (member, no books),
--         c1 stranger (signed in, no profile).

\set ON_ERROR_STOP on

do $$
declare v_company uuid; v_invoice uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x.email, now(), now()
    from (values
      ('0d0c0000-0000-4000-8000-0000000000f1', 'docs-test-f1@example.invalid'),
      ('0d0c0000-0000-4000-8000-0000000000f2', 'docs-test-f2@example.invalid'),
      ('0d0c0000-0000-4000-8000-0000000000c1', 'docs-test-c1@example.invalid')) as x(id, email);
  insert into public.profiles (id, full_name, email, role) values
    ('0d0c0000-0000-4000-8000-0000000000f1', 'Test Finansije', 'docs-test-f1@example.invalid', 'administrator'),
    ('0d0c0000-0000-4000-8000-0000000000f2', 'Test Menadžer',  'docs-test-f2@example.invalid', 'manager');

  insert into public.companies (name, country, currency)
  values ('Test dokumenti (TEST-DOCS)', 'Srbija', 'RSD') returning id into v_company;
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number)
  values (v_company, current_date, 'expense', 'RSD', 1000, 'TEST-DOCS-1') returning id into v_invoice;

  perform set_config('dt.company', v_company::text, true);
  perform set_config('dt.invoice', v_invoice::text, true);
  perform set_config('dt.doc', gen_random_uuid()::text, true);
end $$;

-- A helper path for the fixture invoice.
create temporary table dt_path on commit drop as
  select current_setting('dt.company') || '/' || current_setting('dt.invoice') || '/' || current_setting('dt.doc') || '.pdf' as p;
grant select on dt_path to authenticated;

-- ══ 1. The manager and the stranger cannot upload ═══════════════════════════

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000f2","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    insert into public.invoice_documents (id, invoice_id, company_id, path, filename, bytes)
    values (current_setting('dt.doc')::uuid, current_setting('dt.invoice')::uuid, current_setting('dt.company')::uuid,
            (select p from dt_path), 'racun.pdf', 100);
    raise exception 'FAIL: a manager wrote an invoice document';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('invoice-docs', (select p from dt_path));
    raise exception 'FAIL: a manager put a file in invoice-docs';
  exception when insufficient_privilege then null;
  end;
  raise notice '1 ok';
end $$;

-- ══ 2. Finance uploads; the path must be the document's own ═════════════════

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000f1","role":"authenticated"}';
set local role authenticated;
do $$
begin
  -- A file outside an invoice's folder is refused.
  begin
    insert into storage.objects (bucket_id, name)
    values ('invoice-docs', current_setting('dt.company') || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf');
    raise exception 'FAIL: a file went in under an invoice that does not exist';
  exception when insufficient_privilege then null;
  end;

  insert into storage.objects (bucket_id, name) values ('invoice-docs', (select p from dt_path));

  -- A row whose path is not its own address is refused.
  begin
    insert into public.invoice_documents (invoice_id, company_id, path, filename, bytes)
    values (current_setting('dt.invoice')::uuid, current_setting('dt.company')::uuid, 'drugo/mesto.pdf', 'x.pdf', 1);
    raise exception 'FAIL: a document was written with a free path';
  exception when check_violation then null;
  end;

  insert into public.invoice_documents (id, invoice_id, company_id, path, filename, bytes)
  values (current_setting('dt.doc')::uuid, current_setting('dt.invoice')::uuid, current_setting('dt.company')::uuid,
          (select p from dt_path), 'racun.pdf', 100);

  assert (select uploaded_by from public.invoice_documents where id = current_setting('dt.doc')::uuid)
       = '0d0c0000-0000-4000-8000-0000000000f1'::uuid, 'uploader recorded';

  -- Nobody edits or erases from the browser.
  begin
    update public.invoice_documents set filename = 'drugo.pdf' where id = current_setting('dt.doc')::uuid;
    raise exception 'FAIL: a document was edited';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.invoice_documents where id = current_setting('dt.doc')::uuid;
    raise exception 'FAIL: a document was deleted';
  exception when insufficient_privilege then null;
  end;
  raise notice '2 ok';
end $$;

-- ══ 3. The manager reads; the stranger sees nothing ═════════════════════════

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000f2","role":"authenticated"}';
set local role authenticated;
do $$
begin
  assert (select count(*) from public.invoice_documents where id = current_setting('dt.doc')::uuid) = 1, 'manager reads the row';
  assert (select count(*) from storage.objects where bucket_id = 'invoice-docs' and name = (select p from dt_path)) = 1, 'manager reads the file';
  begin
    perform public.invoice_document_remove(current_setting('dt.doc')::uuid);
    raise exception 'FAIL: a manager removed a document';
  exception when insufficient_privilege then null;
  end;
  raise notice '3a ok';
end $$;

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000c1","role":"authenticated"}';
set local role authenticated;
do $$
begin
  assert (select count(*) from public.invoice_documents) = 0, 'stranger sees no documents';
  assert (select count(*) from storage.objects where bucket_id = 'invoice-docs') = 0, 'stranger sees no files';
  raise notice '3b ok';
end $$;

-- ══ 4. Removal hides the document and keeps the record ══════════════════════

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000f1","role":"authenticated"}';
set local role authenticated;
do $$
begin
  perform public.invoice_document_remove(current_setting('dt.doc')::uuid);
  assert (select removed_by from public.invoice_documents where id = current_setting('dt.doc')::uuid)
       = '0d0c0000-0000-4000-8000-0000000000f1'::uuid, 'remover recorded';
  assert (select count(*) from storage.objects where bucket_id = 'invoice-docs' and name = (select p from dt_path)) = 0,
    'a removed document''s file is no longer readable';
  begin
    perform public.invoice_document_remove(current_setting('dt.doc')::uuid);
    raise exception 'FAIL: removed twice';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '4 ok';
end $$;

reset role;
do $$
begin
  assert (select count(*) from storage.objects where bucket_id = 'invoice-docs' and name = (select p from dt_path)) = 1,
    'the file itself is kept';
  raise notice 'ALL TESTS PASSED';
end $$;
