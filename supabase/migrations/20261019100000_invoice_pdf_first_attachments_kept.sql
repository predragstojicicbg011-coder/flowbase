-- The invoice PDF first; the supplier's attachments kept beside it.
--
-- 20261018120000 kept ONE PDF per invoice and preferred the supplier's
-- attachment over SEF's rendering. In practice that attachment is often a
-- delivery note or a specification, so the finance team and the approvers
-- opened "the invoice" and saw something else.
--
-- From here `sef-fetch-invoice` keeps:
--
--   main PDF     <company_id>/<sef_invoice_id>.pdf            (sef_inbox.pdf_*)
--                SEF's rendering (env:DocumentPdf) whenever present; a
--                supplier attachment only when the rendering is missing.
--   attachments  <company_id>/<sef_invoice_id>/prilog-<n>.pdf (this table)
--                every supplier PDF attachment, one row each.
--
-- Rows opened earlier had their PDFs stripped from the stored XML. The
-- function's `refetch_pdf` option asks SEF for the same document again — only
-- for an invoice that is no longer New there, so nothing changes on SEF — and
-- rewrites the PDFs. `pdf_note` records that it happened.
--
-- Only the edge function writes (service_role, which bypasses RLS). The
-- browser reads rows like it reads `sef_inbox`, and reads the files through
-- signed URLs that storage RLS allows.

begin;

-- ── A note on the PDF ──────────────────────────────────────────────────────

alter table public.sef_inbox add column if not exists pdf_note text;

-- ── The attachments ────────────────────────────────────────────────────────

create table if not exists public.sef_inbox_attachments (
  id           uuid primary key default gen_random_uuid(),
  inbox_id     uuid not null references public.sef_inbox (id) on delete cascade,
  company_id   uuid not null references public.companies (id) on delete cascade,
  n            integer not null check (n >= 1),
  path         text not null unique,
  filename     text,
  description  text,
  sha256       text not null,
  bytes        integer not null check (bytes >= 0),
  saved_at     timestamptz not null default now(),
  unique (inbox_id, n)
);

create index if not exists sef_inbox_attachments_inbox_idx
  on public.sef_inbox_attachments (inbox_id, n);

alter table public.sef_inbox_attachments enable row level security;

revoke all on table public.sef_inbox_attachments from anon, authenticated;
grant select on table public.sef_inbox_attachments to authenticated;
grant select, insert, update, delete on table public.sef_inbox_attachments to service_role;

drop policy if exists members_only on public.sef_inbox_attachments;
create policy members_only on public.sef_inbox_attachments as restrictive
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- Same predicate as `sef_inbox_read`. No insert, update or delete policy:
-- with RLS on, no policy means no access.
drop policy if exists sef_inbox_attachments_read on public.sef_inbox_attachments;
create policy sef_inbox_attachments_read
  on public.sef_inbox_attachments for select to authenticated using (public.is_member());

-- ── Who may read the attachment files ──────────────────────────────────────
--
-- `sef_pdf_read` (20261018120000) is left as it is; this is a second
-- permissive SELECT policy beside it. Same shape: a member, and the object
-- must be a file an attachment row names.

drop policy if exists sef_pdf_attachment_read on storage.objects;
create policy sef_pdf_attachment_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'sef-pdf'
    and public.is_member()
    and exists (
      select 1 from public.sef_inbox_attachments a
       where a.path = storage.objects.name
    )
  );

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sef_inbox_attachments'
       and policyname = 'members_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'sef_inbox_attachments is missing its members_only policy';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'sef_inbox_attachments'
       and (grantee = 'anon' or (grantee = 'authenticated' and privilege_type <> 'SELECT'))
  ) then
    raise exception 'sef_inbox_attachments can be written from the browser, or read by anon';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (qual like '%sef-pdf%' or with_check like '%sef-pdf%')
       and (cmd <> 'SELECT' or 'anon' = any(roles) or 'public' = any(roles))
  ) then
    raise exception 'something other than a signed-in read is allowed on sef-pdf';
  end if;

  if has_column_privilege('authenticated', 'public.sef_inbox', 'pdf_note', 'UPDATE') then
    raise exception 'the PDF note can be written from the browser';
  end if;
end $$;

commit;
