# Rate-limit fix for sef-pull-sales

## Changes
- salesInvoice.ts: pure MIN_GAP_MS (400), MAX_RATE_RETRIES (3), paceWaitMs, nextDelayMs (1s/2s/4s, 429 only), retryPlan (done / retry / out_of_time / rate_limited), RATE_LIMITED message naming the rate limit.
- sef-pull-sales/index.ts: the single `sef()` helper paces (400 ms gap) and retries 429; all calls (ids, sales-invoice, xml, pdf, changes) already went through it. Budget: a wait/retry that would pass 110 s throws OutOfTime; the ids stage returns complete with more:true, per-invoice, changes and ask-again loops break with more=true. Exhausted retries throw Refused(RATE_LIMITED, 429) so the run fails with a clear message. 401/403 unchanged.
- sef-check: the sales probe waits 0.5 s and retries once after 1.5 s on 429.
- Migration 20261104130000_sales_pull_after_purchase.sql: reschedules sef-pull-sales-quarter-hourly to '7-59/15 5-17 * * *' only if cron.job exists and has the job.
- Test: supabase/tests/sales_pull_after_purchase_test.sql (new); Jest tests added to src/services/sefSales.function.test.ts.

## Verification
- Jest sefSales.function before implementation: 5 failed, 25 passed (RED); after: 30/30 (GREEN).
- SQL test before migration: ERROR 'the sales pull is not seven minutes after...' (RED); with migration: ALL TESTS PASSED; also with migration 090000 in front: PASSED. All rolled back.
- npx tsc --noEmit -p . clean. Full Jest: 145 suites, 2923 tests passed.
- Edge function itself is not executed by tests (Deno); only the pure logic is.
