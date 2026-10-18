import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Does the SEF key work? ─────────────────────────────────────────────────
//
// POST {}
//
// Asks SEF ONE harmless question with the saved key: the list of incoming
// invoices for today, through `purchase-invoice/overview` — exactly the call
// `sef-pull` makes, only with a one-day window. That call was measured against
// the live service and does NOT move any invoice out of `New` (migration
// 20261015100000), so checking the connection opens nothing the accounting
// firm has not looked at yet.
//
// Nothing here calls a document, xml, pdf or accept/reject endpoint, and
// nothing is stored. The key is read with the service role and is never put
// in a response or a log line.
//
// Members may check (is_member(), asked of the database with the caller's own
// token). Setting the key is the administrator's, and happens elsewhere
// (`sef_set_api_key`).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, code, ...extra }, status)

const PRODUCTION = 'https://efaktura.mfin.gov.rs/api/publicApi'
const SEF_TIMEOUT_MS = 20_000

const KEY_REJECTED =
  'SEF je odbio ključ — proverite da je ključ aktivan u SEF portalu (Podešavanja → API upravljanje)'
const SEF_UNAVAILABLE = 'SEF nije dostupan'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method', 'Samo POST.')

  const url = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // ── WHO IS CALLING ──────────────────────────────────────────────────────
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return fail(401, 'unauthenticated', 'Prijavite se ponovo.')
  const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
  if (whoErr || !who?.user) return fail(401, 'unauthenticated', 'Prijavite se ponovo.')

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  if (!anonKey) return fail(500, 'config', 'Funkciji nedostaje SUPABASE_ANON_KEY.')
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const member = await asCaller.rpc('is_member')
  if (member.error) return fail(500, 'role_unknown', `Uloga nije mogla da se proveri: ${member.error.message}`)
  if (member.data !== true) return fail(403, 'forbidden', 'Vezu sa SEF-om proveravaju samo članovi firme.')

  // ── THE KEY ─────────────────────────────────────────────────────────────
  // Read exactly as `sef-pull` reads it, including `extra.base_url`, which is
  // how a demo key points at the demo server.
  const { data: creds, error: credErr } = await supabase
    .from('integration_credentials').select('api_key, extra')
    .eq('provider', 'sef').eq('is_active', true).limit(1)
  if (credErr) return fail(500, 'no_credentials', 'SEF ključ nije mogao da se pročita.')
  const cred = creds?.[0]
  if (!cred?.api_key) return fail(400, 'no_credentials', 'SEF ključ nije podešen.')
  const extra = (cred.extra || {}) as { base_url?: string }
  const base = extra.base_url || PRODUCTION
  const environment = !extra.base_url ? 'production' : /demoefaktura/i.test(extra.base_url) ? 'demo' : 'other'

  // ── THE ONE CALL ────────────────────────────────────────────────────────
  // Today in Belgrade, as `sef_pull_window` reckons the end of its window.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date())
  const sefUrl = `${base}/purchase-invoice/overview?dateFrom=${today}&dateTo=${today}`

  let res: Response
  try {
    res = await fetch(sefUrl, { headers: { ApiKey: cred.api_key }, signal: AbortSignal.timeout(SEF_TIMEOUT_MS) })
  } catch (e) {
    console.error('sef-check: SEF could not be reached:', e instanceof Error ? e.name : 'error')
    return fail(502, 'sef_unavailable', SEF_UNAVAILABLE, { environment })
  }

  if (res.status === 401 || res.status === 403) {
    return fail(res.status, 'key_rejected', KEY_REJECTED, { environment, http_status: res.status })
  }
  if (res.status >= 500) {
    return fail(502, 'sef_unavailable', SEF_UNAVAILABLE, { environment, http_status: res.status })
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    return fail(502, 'sef_refused', `SEF je odbio proveru (${res.status})${detail ? `: ${detail}` : '.'}`,
      { environment, http_status: res.status })
  }

  const rows = await res.json().catch(() => null)
  if (!Array.isArray(rows)) {
    return fail(502, 'sef_refused', 'SEF je odgovorio nečim što nije spisak faktura.', { environment })
  }

  return json({
    ok: true,
    environment,
    invoices_seen: rows.length,
    message: `Veza sa SEF-om radi. Danas pristiglih faktura: ${rows.length}.`,
  })
})
