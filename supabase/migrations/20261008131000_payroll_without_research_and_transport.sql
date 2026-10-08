-- ============================================================================
-- Payroll without R&D, the R&D subsidy, or the transport allowance
--
-- MCFlow runs classic Serbian payroll: one salary run a month plus other
-- income. There is no research engagement, no tax subsidy under articles
-- 21и and 45з, and no travel allowance. The app code that read and wrote
-- these is removed in the same change.
--
-- Kept on purpose: `payroll_lines.rev_alloc_af_pct`. It belongs to the
-- revenue-allocation plumbing shared with invoices and transactions, which a
-- later phase replaces with projects.
--
-- No views, functions or triggers in the baseline read any of these. No
-- CASCADE: an unknown dependency fails the migration instead of vanishing.
-- ============================================================================


-- ── The R&D engagement ──────────────────────────────────────────────────────
-- Its policies, index and keys go with the table; nothing else points at it.

drop table if exists public.employee_research_engagement;


-- ── R&D hours on the timesheet ──────────────────────────────────────────────

alter table public.payroll_timesheets
  drop constraint if exists payroll_timesheets_research_hours_check;
alter table public.payroll_timesheets
  drop column if exists research_hours;


-- ── The subsidy, reported on runs, their lines and postings ─────────────────

alter table public.payroll_postings drop column if exists subsidy;
alter table public.payroll_run_lines drop column if exists subsidy;
alter table public.payroll_runs drop column if exists subsidy;


-- ── The transport allowance on a contract ───────────────────────────────────

alter table public.employee_contracts
  drop constraint if exists employee_contracts_transport_net_check;
alter table public.employee_contracts
  drop column if exists transport_net;
