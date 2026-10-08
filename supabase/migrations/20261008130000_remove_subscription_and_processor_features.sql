-- ============================================================================
-- Remove the subscription and payment-processor machinery
--
-- MCFlow bills construction progress and building rentals, entered by hand.
-- Nothing here syncs from Chargebee, Braintree, Stripe or PayPal, so the
-- tables those syncs wrote, the views over them, and the functions that ran
-- them go. The app code that read them is removed in the same change.
--
-- Kept on purpose: `revenue_entries`, `revenue_collections`,
-- `revenue_entry_collections` and `v_revenue_entry_status`. A later phase
-- reworks revenue around projects; until then they hold manual entries.
--
-- No CASCADE anywhere. Every dependency is dropped by name, in order, so an
-- object this file does not know about fails the migration instead of
-- disappearing with it.
-- ============================================================================


-- ── Views first: they read the tables below ────────────────────────────────

drop view if exists public.v_chargebee_latest_subscriptions;
drop view if exists public.v_chargebee_latest_runs;
drop view if exists public.v_processor_latest;


-- ── Functions: the cron entry points, the run claims, the Braintree lookup ─

drop function if exists public.run_chargebee_snapshot(boolean, text);
drop function if exists public.run_processor_sync(text, boolean, jsonb);
drop function if exists public.claim_chargebee_snapshot(date, text, uuid, text, interval);
drop function if exists public.claim_processor_sync(date, text, text, interval);
drop function if exists public.get_unmatched_braintree(text, date, date, integer);


-- ── Tables: children before the runs they point at ─────────────────────────

-- Chargebee snapshots (`run_id` references `chargebee_snapshot_runs`).
drop table if exists public.chargebee_subscription_snapshots;
drop table if exists public.chargebee_snapshot_runs;
drop table if exists public.chargebee_site_brands;

-- Processor syncs (`run_id` references `processor_sync_runs`).
drop table if exists public.processor_transactions;
drop table if exists public.processor_sync_runs;

-- The scheduler's log and settings, used only by the two `run_*` functions.
drop table if exists public.scheduled_job_runs;
drop table if exists public.job_config;

-- API keys for the integrations and the manual sync log.
drop table if exists public.integration_credentials;
drop table if exists public.sync_logs;

-- Processing-fee and chargeback rates, and the forecast's typed corrections.
drop table if exists public.revenue_settings;
drop table if exists public.revenue_estimate_adjustments;


-- ── revenue_collections: what only made sense for Chargebee ────────────────

-- The check allowed `chargebee_<site>` and nothing else (the list of other
-- names was empty), so no manual collection could be saved. Replaced with
-- the generic half of it: a source must be named.
alter table public.revenue_collections
  drop constraint if exists revenue_collections_processor_check;
alter table public.revenue_collections
  add constraint revenue_collections_processor_check
  check (btrim(processor) <> '');

-- Copied the gateway id out of the JSON a Chargebee sync left in `notes`.
-- Manual rows never carry it. The column and its index stay until the
-- revenue rework decides what a collection holds.
drop trigger if exists revenue_collections_fill_gateway on public.revenue_collections;
drop function if exists public.fill_id_at_gateway();
