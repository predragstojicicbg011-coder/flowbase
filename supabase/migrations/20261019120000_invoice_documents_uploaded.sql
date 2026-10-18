-- PDFs uploaded by hand to a booked invoice.
--
-- An invoice booked from SEF carries its PDF and the supplier's attachments
-- (bucket `sef-pdf`). Everything else — a foreign supplier, a utility bill
-- that never went through SEF, a scanned delivery note, a signed progress
-- billing — had nowhere to go. It goes here:
--
--   bucket  invoice-docs   (private, PDF only, 15 MB)
--   path    <company_id>/<invoice_id>/<document_id>.pdf
--   row     public.invoice_documents, one per file
--
-- Who may do what:
--   * every member reads (the same rule as the invoices themselves);
--   * the finance team (can_write_books) uploads;
--   * the finance team removes, through invoice_document_remove — which
--     HIDES the document and records who and when. The file stays in the
--     bucket and the row stays in the table, so a removal can be accounted
--     for later. Nobody updates or deletes from the browser.
--
-- The browser uploads the file first, then writes the row. Storage lets a
-- file in only under an existing invoice's folder; a file whose row never
-- arrives is readable by nobody, since reading needs a live row naming it.

begin;

-- ── The bucket ─────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-docs', 'invoice-docs', false, 15728640, array['application/pdf'])
on conflict (id) do nothing;

-- ── The table ──────────────────────────────────────────────────────────────

create table if not exists public.invoice_documents (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices (id) on delete cascade,
  company_id   uuid not null references public.companies (id) on delete cascade,
  path         text not null unique,
  filename     text not null check (btrim(filename) <> ''),
  description  text,
  bytes        integer not null check (bytes > 0),
  uploaded_by  uuid not null default auth.uid(),
  uploaded_at  timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid,
  -- The path is the document's own address, not something to choose freely.
  constraint invoice_documents_path_shape
    check (path = company_id::text || '/' || invoice_id::text || '/' || id::text || '.pdf'),
  constraint invoice_documents_removal_says_who
    check ((removed_at is null) = (removed_by is null))
);

create index if not exists invoice_documents_invoice_idx
  on public.invoice_documents (invoice_id) where removed_at is null;

alter table public.invoice_documents enable row level security;

revoke all on table public.invoice_documents from anon, authenticated;
grant select, insert on table public.invoice_documents to authenticated;
grant select, insert, update, delete on table public.invoice_documents to service_role;

drop policy if exists members_only on public.invoice_documents;
create policy members_only on public.invoice_documents as restrictive
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists invoice_documents_read on public.invoice_documents;
create policy invoice_documents_read
  on public.invoice_documents for select to authenticated
  using (public.is_member());

-- An upload is written as its uploader, live, under a live invoice of the
-- same company.
drop policy if exists invoice_documents_upload on public.invoice_documents;
create policy invoice_documents_upload
  on public.invoice_documents for insert to authenticated
  with check (
    public.can_write_books()
    and uploaded_by = auth.uid()
    and removed_at is null and removed_by is null
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_documents.invoice_id
         and i.company_id = invoice_documents.company_id
         and i.deleted_at is null
    )
  );

-- ── Removal: hidden, never erased ──────────────────────────────────────────

create or replace function public.invoice_document_remove(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.can_write_books() then
    raise exception 'Samo finansijski tim može da ukloni dokument sa fakture.'
      using errcode = 'insufficient_privilege';
  end if;
  update public.invoice_documents
     set removed_at = now(), removed_by = auth.uid()
   where id = p_id and removed_at is null;
  if not found then
    raise exception 'Taj dokument ne postoji ili je već uklonjen.';
  end if;
end
$$;

revoke all on function public.invoice_document_remove(uuid) from public, anon;
grant execute on function public.invoice_document_remove(uuid) to authenticated;

-- ── The files ──────────────────────────────────────────────────────────────
--
-- In: the finance team, into <company_id>/<invoice_id>/ of a live invoice,
-- a .pdf name. Out: a member, for a file a live row names. No UPDATE or
-- DELETE policy: with RLS on storage.objects, no policy means no access.

drop policy if exists invoice_docs_upload on storage.objects;
create policy invoice_docs_upload
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'invoice-docs'
    and public.can_write_books()
    and storage.objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$'
    and exists (
      select 1 from public.invoices i
       where i.company_id::text = (storage.foldername(storage.objects.name))[1]
         and i.id::text = (storage.foldername(storage.objects.name))[2]
         and i.deleted_at is null
    )
  );

drop policy if exists invoice_docs_read on storage.objects;
create policy invoice_docs_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'invoice-docs'
    and public.is_member()
    and exists (
      select 1 from public.invoice_documents d
       where d.path = storage.objects.name and d.removed_at is null
    )
  );

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'invoice-docs' and not public) then
    raise exception 'the invoice-docs bucket is missing, or public';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'invoice_documents'
       and policyname = 'members_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'invoice_documents is missing its members_only policy';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'invoice_documents'
       and (grantee = 'anon'
            or (grantee = 'authenticated' and privilege_type not in ('SELECT', 'INSERT')))
  ) then
    raise exception 'invoice_documents can be changed from the browser, or read by anon';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (qual like '%invoice-docs%' or with_check like '%invoice-docs%')
       and (cmd not in ('SELECT', 'INSERT') or 'anon' = any(roles) or 'public' = any(roles))
  ) then
    raise exception 'something other than a signed-in read or upload is allowed on invoice-docs';
  end if;
end $$;

commit;
