import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Reading the post without opening it ────────────────────────────────────
//
// THIS FUNCTION DOES NOT CONTAIN THE URL OF A DOCUMENT, AND MUST NOT GAIN ONE.
//
// Asking SEF for an invoice's document, through the purchase-invoice service
// or either of its file endpoints, moves that invoice from `New` to `Seen`,
// and the accounting firm reads the same inbox and relies on that status.
// `overview` returns headers and leaves it alone.
//
// Keeping that rule as the absence of code rather than as a comment somebody
// has to obey is the whole reason this is a separate function from
// `sef-fetch-invoice`.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // WHO IS CALLING.
  //
  // Two legitimate callers: cron, which presents a service-role credential, and
  // the owner's browser, which presents his signed-in token. Everyone else
  // holds the anon key, which is published - and spending SEF calls, or marking
  // an invoice `Seen` in a mailbox the owner's accountants read, is not
  // something a stranger with a public key should be able to do.
  //
  // THE TWO CREDENTIALS ARE BOTH REAL AND ARE NOT THE SAME STRING. This project
  // issues legacy `anon`/`service_role` JWTs *and* new `sb_secret_...` keys.
  // Cron sends what is stored in `job_config.service_role_key`, the legacy JWT,
  // while this function's own `SUPABASE_SERVICE_ROLE_KEY` holds the newer
  // secret. Comparing the two whole strings refused every scheduled pull with
  // 401 while both credentials were perfectly valid, and the inbox stayed
  // empty. Whole-string equality is an accept here, never the only one.
  //
  // VERIFIED, not decoded. Reading `role` out of the token without checking its
  // signature would leave an unsigned `{"role":"service_role"}` working the
  // moment the gateway is turned off. Instead the token is spent on an endpoint
  // only a service-role credential may use: the auth server checks the
  // signature itself and answers 401 or 403 for anything less. That is
  // format-agnostic - it holds for a legacy JWT and an `sb_secret_...` alike,
  // so a future key migration cannot break it the way this one did.
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || ''

  // The `!== ''` guards are deliberate: without them a missing env var would
  // make an absent Authorization header match an empty key and let everyone in.
  let allowed = (serviceKey !== '' && bearer === serviceKey)
             || (secretKey !== '' && bearer === secretKey)

  // Cron's credential, of which this function holds no copy. Spending it on an
  // admin endpoint is the only way to learn whether it really carries
  // service_role; an anon key is refused there, and so is a forgery.
  if (!allowed && bearer !== '') {
    const probe = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
    const { error: probeErr } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 })
    allowed = !probeErr
  }

  // A person's browser. Signed in is not enough: since the approval app,
  // some signed-in accounts are not company members at all. The database
  // decides the role, with the caller's own token, as sef-decide does.
  if (!allowed && bearer !== '') {
    const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
    if (!whoErr && who?.user) {
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
      if (!anonKey) return json({ error: 'Funkciji nedostaje SUPABASE_ANON_KEY.' }, 500)
      const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, anonKey, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const [member] = await Promise.all([asCaller.rpc('is_member')])
      if (member.error) return json({ error: 'Uloga nije mogla da se proveri.' }, 500)
      if (!(member.data === true)) return json({ error: 'SEF povlačenje pokreću samo članovi firme.' }, 403)
      allowed = true
    }
  }

  if (!allowed) return json({ error: 'Sign in first.' }, 401)

  const body = await req.json().catch(() => ({}))

  // A run is claimed, not inserted. `processor_sync_runs` is unique on
  // (sync_date, provider, account), so a plain insert would be refused on the
  // second pass of the day, and this job passes dozens of times a day. The
  // claim also makes a call that overlaps a running one a no-op, which matters
  // when somebody runs this by hand while the schedule is mid-pass.
  const syncDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date())
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_processor_sync', {
    p_date: syncDate, p_provider: 'sef', p_account: '',
  })
  if (claimErr) {
    return json({ provider: 'sef', status: 'failed', error: `Could not claim the run: ${claimErr.message}` }, 500)
  }
  if (claimed === null || claimed === undefined) {
    return json({ provider: 'sef', skipped: true, message: 'SEF is already being pulled. Nothing was touched.' })
  }
  const runId = claimed as number

  // `supabase-js` returns an error rather than throwing, so a close that fails
  // would leave the row `running` while the response said complete. The failure
  // is carried back instead of thrown: the work itself has succeeded, and the
  // run row self-heals once the claim's staleness window passes.
  const close = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from('processor_sync_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId)
    return error ? { closed: false, closeError: error.message } : {}
  }

  const fail = async (message: string, status = 500) => {
    const closed = await close({ status: 'failed', error: message })
    return json({ provider: 'sef', status: 'failed', error: message, ...closed }, status)
  }

  try {
    // Nothing reads this function's response (pg_net discards it), so the run
    // row is the only record. The credential checks therefore sit AFTER the
    // claim and go through `fail`: a missing row otherwise leaves the inbox
    // silently empty with nothing anywhere saying why.
    const { data: creds, error: credErr } = await supabase
      .from('integration_credentials')
      .select('*')
      .eq('provider', 'sef')
      .eq('is_active', true)
      .limit(1)
    if (credErr) return await fail(`Could not read the SEF credentials: ${credErr.message}`)

    const cred = creds?.[0]
    if (!cred?.api_key) {
      return await fail('No active SEF credentials. Add a row to integration_credentials with provider = sef.', 400)
    }
    // `integration_credentials` is shared with Chargebee and Braintree and has no
    // column for either of these — `extra` is the jsonb slot for exactly this, and
    // no other provider uses it. Adding columns to a shared table for one
    // integration's sake is not worth it.
    const extra = (cred.extra || {}) as { company_id?: string; base_url?: string }
    if (!extra.company_id) {
      return await fail('The SEF credential row carries no company_id in its `extra` column, so there is nothing to file the invoices under.', 400)
    }

    // The window is Postgres's, not this function's: the floor lives beside the
    // config it is read from, and Belgrade's end of summer time is handled by a
    // timezone database rather than by an offset written here.
    const { data: win, error: winErr } = await supabase
      .rpc('sef_pull_window', { p_from: body.from ?? null, p_to: body.to ?? null })
    const w = Array.isArray(win) ? win[0] : win
    if (winErr || !w) return await fail(`Could not work out the window: ${winErr?.message}`)

    // The floor can be later than the end of the window: a floor set to next
    // month, or a manual range that ends before it. SEF would be asked for a
    // backwards range, which means nothing, so it is not asked. Closed as
    // complete because nothing went wrong; the error says why nothing came.
    if (w.date_from > w.date_to) {
      const note = `The configured floor (${w.date_from}) is later than the end of the window (${w.date_to}), so SEF was not asked.`
      const closed = await close({
        status: 'complete', transactions: 0,
        period_from: w.date_from, period_to: w.date_to, error: note,
      })
      return json({
        provider: 'sef', status: 'complete', seen: 0, inserted: 0, skipped: 0,
        from: w.date_from, to: w.date_to, note, ...closed,
      })
    }

    const base = extra.base_url || 'https://efaktura.mfin.gov.rs/api/publicApi'
    const url = `${base}/purchase-invoice/overview`
      + `?dateFrom=${w.date_from}&dateTo=${w.date_to}`

    // Measurement 2 has not been run: nobody has confirmed whether `status` is
    // required by `overview`. The single call below is right if it is optional
    // and every status comes back when it is left out.
    //
    // IF `status` TURNS OUT TO BE MANDATORY (SEF answers 400 naming it), a
    // single call reads nothing at all. Replace the fetch and the response
    // handling that follows it with a loop over the statuses, concatenating
    // before the upsert:
    //
    //   const STATUSES = ['New', 'Seen', 'ReNotified', 'Approved', 'Rejected', 'Cancelled', 'Storno']
    //   const rows: unknown[] = []
    //   for (const s of STATUSES) {
    //     const r = await fetch(`${url}&status=${s}`, { headers: { ApiKey: cred.api_key } })
    //     if (!r.ok) return await fail(`SEF answered ${r.status} for status ${s}`)
    //     rows.push(...(await r.json()))
    //   }
    //
    // Keep the 401/403 check on each response in that version too.
    let res: Response
    try {
      // A hung connection would otherwise hold the claim until it goes stale.
      res = await fetch(url, { headers: { ApiKey: cred.api_key }, signal: AbortSignal.timeout(60_000) })
    } catch (e) {
      return await fail(`SEF could not be reached: ${e instanceof Error ? e.message : String(e)}`)
    }

    // A dead key and an empty inbox must not look the same. Keys expire, and
    // "no new invoices" is what a 401 would otherwise read as. A 403 is not
    // necessarily a dead key: it can be a key without permission for this.
    if (res.status === 401) {
      return await fail('SEF rejected the key. Check it in Settings → API Management and update integration_credentials.', 401)
    }
    if (res.status === 403) {
      return await fail('SEF refused the request — the key may lack permission for incoming invoices.', 403)
    }
    if (!res.ok) {
      return await fail(`SEF answered ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }

    const rows = await res.json().catch(() => null)
    if (!Array.isArray(rows)) {
      return await fail('SEF answered something that is not a list of invoices.')
    }

    const { data: merged, error: upErr } = await supabase
      .rpc('sef_inbox_upsert', { p_company_id: extra.company_id, p_rows: rows })
    if (upErr) return await fail(`The inbox refused the merge: ${upErr.message}`)

    const m = Array.isArray(merged) ? merged[0] : merged
    // A merge that reports nothing is not a merge that stored nothing. Closing
    // that as "complete, zero seen" would be the quiet short queue again.
    if (!m) return await fail('The inbox merged without saying what it did.')

    const seen = m.seen ?? 0
    const inserted = m.inserted ?? 0
    const skipped = m.skipped ?? 0

    const closed = await close({
      status: 'complete',
      transactions: seen,
      period_from: w.date_from, period_to: w.date_to,
      // Rows SEF sent that could not be keyed are not stored. The run is still
      // complete, but a pass that drops rows says so where somebody will look.
      error: skipped > 0 ? `${skipped} row(s) had no usable invoice id and were not stored.` : null,
    })

    return json({
      provider: 'sef', status: 'complete',
      seen, inserted, skipped,
      from: w.date_from, to: w.date_to,
      ...closed,
    })
  } catch (e) {
    return await fail(String((e as Error)?.message || e))
  }
})
