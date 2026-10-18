-- The invoice PDF is kept.
--
-- `sef-fetch-invoice` asks SEF for a document exactly once, and until now it
-- threw away the two base64 PDFs that ride in the envelope. The XML is what
-- the books are made from, but the PDF is what a person looks at — and it
-- cannot be fetched again later without a second SEF call, which is the one
-- thing that function promises not to make.
--
-- So the PDF is decoded at that one fetch and stored in a PRIVATE bucket:
--
--   bucket  sef-pdf
--   path    <company_id>/<sef_invoice_id>.pdf
--
-- Which PDF: the supplier's own attachment
-- (cac:AdditionalDocumentReference/…/cbc:EmbeddedDocumentBinaryObject,
-- mimeCode application/pdf) when there is one, because that is the document
-- the supplier issued; otherwise SEF's rendering (env:DocumentPdf).
-- `pdf_kind` says which.
--
-- Only the edge function writes, as service_role (which bypasses RLS). The
-- browser reads through a signed URL, and storage RLS decides whether it may
-- sign one. A row opened before this migration has no PDF and never will: the
-- bytes were stripped, and fetching again would be a second SEF call.

begin;

-- ── The bucket ─────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sef-pdf', 'sef-pdf', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- ── The columns ────────────────────────────────────────────────────────────

alter table public.sef_inbox
  add column if not exists pdf_path     text,
  add column if not exists pdf_sha256   text,
  add column if not exists pdf_bytes    integer,
  add column if not exists pdf_kind     text,
  add column if not exists pdf_saved_at timestamptz;

alter table public.sef_inbox drop constraint if exists sef_inbox_pdf_kind_known;
alter table public.sef_inbox add constraint sef_inbox_pdf_kind_known
  check (pdf_kind is null or pdf_kind in ('supplier_attachment', 'sef_rendering'));

-- The `grant select on table` in 20261015100000 covers new columns already;
-- `authenticated` gets no UPDATE on any of these (column grants there name
-- only the four decision columns).

-- ── Who may read the files ─────────────────────────────────────────────────
--
-- Mirrors `sef_inbox_read` (`public.is_member()`), and in addition the object
-- must be the PDF an inbox row names — a stray file in the bucket is readable
-- by nobody. No INSERT, UPDATE or DELETE policy for `authenticated`: with RLS
-- on storage.objects, no policy means no access. No policy at all for `anon`.

drop policy if exists sef_pdf_read on storage.objects;
create policy sef_pdf_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'sef-pdf'
    and public.is_member()
    and exists (
      select 1 from public.sef_inbox i
       where i.pdf_path = storage.objects.name
    )
  );

create index if not exists sef_inbox_pdf_path_idx
  on public.sef_inbox (pdf_path) where pdf_path is not null;

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'sef-pdf' and not public) then
    raise exception 'the sef-pdf bucket is missing, or public';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (qual like '%sef-pdf%' or with_check like '%sef-pdf%')
       and (cmd <> 'SELECT' or 'anon' = any(roles) or 'public' = any(roles))
  ) then
    raise exception 'something other than a signed-in read is allowed on sef-pdf';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' and table_name = 'sef_inbox'
  ) then
    raise exception 'anon was granted rights on sef_inbox';
  end if;

  if has_column_privilege('authenticated', 'public.sef_inbox', 'pdf_path', 'UPDATE') then
    raise exception 'the PDF path can be written from the browser';
  end if;
end $$;

commit;
