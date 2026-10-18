import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Accept or reject a supplier's invoice ON SEF ───────────────────────────
//
// POST { inbox_id, accepted, comment }
//
// This is a write to a government register that the supplier and the
// accounting firm both see, so everything that can be refused is refused
// BEFORE SEF is asked:
//
//   * the caller is signed in and keeps the books (`can_write_books()`, asked
//     of the database with the caller's own token);
//   * the switch `feature_flags.sef_decisions_enabled` is on;
//   * a rejection carries a comment;
//   * the invoice has been opened (its document fetched) — nobody accepts a
//     bill nobody has read;
//   * an accepted invoice is final; a rejected one may still be accepted.
//
// Then SEF is called EXACTLY ONCE. The call is not safe to repeat — a timeout
// does not mean SEF did nothing — so nothing here retries, and the person is
// told to try again only after checking.
//
// Every attempt that reaches the call is recorded in `sef_decisions`, whatever
// came back. Only a success updates the inbox row.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, code, ...extra }, status)

const SEF_TIMEOUT_MS = 30_000

// ─── Reading SEF's answer ───────────────────────────────────────────────────
//
// A minimal copy of `readSefDecisionResponse` in `src/services/sef/sefDecide.ts`,
// which is where it is tested: the edge functions share no code with the app.
// Change both together. The live server answers PascalCase while its published
// schema says camelCase — so keys are matched without regard to case, as
// `jsonb_value_ci` does for the pull.

function ci(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const want = key.toLowerCase()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.toLowerCase() === want) return v
  }
  return undefined
}

function readSefDecisionResponse(body: unknown) {
  const invoice = ci(body, 'invoice')
  const success = ci(body, 'success')
  const status = ci(invoice, 'status')
  const number = ci(invoice, 'invoiceNumber')
  const message = ci(body, 'message')
  return {
    success: typeof success === 'boolean' ? success : null,
    status: typeof status === 'string' && status.trim() ? status.trim() : null,
    invoiceNumber: typeof number === 'string' && number.trim() ? number.trim() : null,
    message: typeof message === 'string' && message.trim() ? message.trim() : null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method', 'Samo POST.')

  const url = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // ── WHO IS CALLING ──────────────────────────────────────────────────────
  //
  // Only a person. Unlike `sef-fetch-invoice` there is no cron caller and no
  // service-role path: a decision on SEF is always somebody's, and that
  // somebody is recorded. The token is verified by the auth server.
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return fail(401, 'unauthenticated', 'Prijavite se ponovo.')

  const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
  const user = who?.user
  if (whoErr || !user) return fail(401, 'unauthenticated', 'Prijavite se ponovo.')

  // The database decides who keeps the books, with the caller's own token, so
  // the role list lives in one place (`can_write_books()`, 20261010090000).
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  if (!anonKey) return fail(500, 'config', 'Funkciji nedostaje SUPABASE_ANON_KEY.')
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const [member, books] = await Promise.all([
    asCaller.rpc('is_member'),
    asCaller.rpc('can_write_books'),
  ])
  if (member.error || books.error) {
    return fail(500, 'role_unknown', `Uloga nije mogla da se proveri: ${(member.error || books.error)!.message}`)
  }
  if (member.data !== true || books.data !== true) {
    return fail(403, 'forbidden', 'Odluku na SEF-u donosi samo neko ko vodi knjige (administrator, vlasnik ili administrativni asistent).')
  }

  // ── WHAT IS ASKED ───────────────────────────────────────────────────────
  const body = await req.json().catch(() => null) as
    { inbox_id?: unknown; accepted?: unknown; comment?: unknown } | null
  const inboxId = typeof body?.inbox_id === 'string' ? body.inbox_id : ''
  if (!inboxId) return fail(400, 'bad_request', 'Nije navedena faktura.')
  if (typeof body?.accepted !== 'boolean') return fail(400, 'bad_request', 'Nije rečeno da li se faktura prihvata ili odbija.')
  const accepted = body.accepted
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
  if (!accepted && !comment) {
    return fail(400, 'comment_required', 'Za odbijanje na SEF-u potreban je komentar.')
  }
  if (comment.length > 1000) return fail(400, 'bad_request', 'Komentar je predug (najviše 1000 znakova).')

  // ── THE SWITCH ──────────────────────────────────────────────────────────
  // A missing row is OFF: the feature is opted into, never assumed.
  const { data: flag, error: flagErr } = await supabase
    .from('feature_flags').select('enabled').eq('name', 'sef_decisions_enabled').maybeSingle()
  if (flagErr) return fail(500, 'switch_unknown', `Prekidač nije mogao da se pročita: ${flagErr.message}`)
  if (flag?.enabled !== true) {
    return fail(409, 'switch_off', 'Odlučivanje na SEF-u nije uključeno (Podešavanja)')
  }

  // ── THE ROW ─────────────────────────────────────────────────────────────
  const { data: row, error: rowErr } = await supabase
    .from('sef_inbox')
    .select('id, company_id, sef_invoice_id, ubl_fetched_at, sef_decision')
    .eq('id', inboxId).maybeSingle()
  if (rowErr) return fail(500, 'failed', `Faktura nije mogla da se pročita: ${rowErr.message}`)
  if (!row) return fail(404, 'not_found', 'Te fakture nema u SEF sandučetu.')

  if (!row.ubl_fetched_at) {
    return fail(409, 'not_opened', 'Prvo otvorite fakturu: odluka se donosi o dokumentu koji je neko pročitao.')
  }
  if (row.sef_decision === 'accepted') {
    return fail(409, 'already_accepted', 'Faktura je već prihvaćena na SEF-u i ta odluka je konačna.')
  }
  if (row.sef_decision === 'rejected' && !accepted) {
    return fail(409, 'already_rejected', 'Faktura je već odbijena na SEF-u. Može se još samo prihvatiti.')
  }

  // ── THE KEY ─────────────────────────────────────────────────────────────
  // Read exactly as `sef-fetch-invoice` reads it, including `extra.base_url`,
  // which is how a demo key points at the demo server.
  const { data: creds, error: credErr } = await supabase
    .from('integration_credentials').select('*')
    .eq('provider', 'sef').eq('is_active', true).limit(1)
  if (credErr) return fail(500, 'no_credentials', `SEF ključ nije mogao da se pročita: ${credErr.message}`)
  const cred = creds?.[0]
  if (!cred?.api_key) return fail(400, 'no_credentials', 'Nema aktivnog SEF ključa (integration_credentials, provider sef).')
  const extra = (cred.extra || {}) as { base_url?: string }
  const base = extra.base_url || 'https://efaktura.mfin.gov.rs/api/publicApi'

  // ── THE ONE CALL ────────────────────────────────────────────────────────
  const requestedAt = new Date().toISOString()
  const payload: Record<string, unknown> = { invoiceId: Number(row.sef_invoice_id), accepted }
  // Optional on accept, so left out rather than sent empty.
  if (comment) payload.comment = comment

  const record = async (r: {
    http_status: number | null; success: boolean; sef_status?: string | null
    response?: unknown; error?: string | null
  }): Promise<string | null> => {
    const { error } = await supabase.from('sef_decisions').insert({
      inbox_id: row.id, company_id: row.company_id, accepted,
      comment: comment || null, requested_by: user.id, requested_at: requestedAt,
      http_status: r.http_status, success: r.success, sef_status: r.sef_status ?? null,
      response: r.response ?? null, error: r.error ?? null,
    })
    return error ? error.message : null
  }

  let res: Response
  try {
    res = await fetch(`${base}/purchase-invoice/acceptRejectPurchaseInvoice`, {
      method: 'POST',
      headers: { ApiKey: cred.api_key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEF_TIMEOUT_MS),
    })
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    await record({ http_status: null, success: false, error: why })
    // NOT retried: the request may have reached SEF before the line went quiet.
    return fail(504, 'sef_unavailable',
      'SEF nije dostupan, pokušajte ponovo. Ako je zahtev ipak stigao, odluka će se videti u statusu posle sledećeg povlačenja.')
  }

  const text = await res.text().catch(() => '')
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  const answer = readSefDecisionResponse(parsed)
  const response = parsed ?? (text ? { raw: text.slice(0, 2000) } : null)

  if (!res.ok || answer.success !== true) {
    const detail = answer.message || (parsed ? '' : text.slice(0, 300))
    let status: number, code: string, msg: string
    if (res.status === 401) {
      status = 401; code = 'key_rejected'
      msg = 'SEF je odbio API ključ. Proverite ga na SEF-u (Podešavanja → API) i u integration_credentials.'
    } else if (res.status === 403) {
      status = 403; code = 'key_forbidden'
      msg = 'SEF je odbio zahtev — ključ možda nema dozvolu za ulazne fakture.'
    } else if (res.status >= 500) {
      status = 502; code = 'sef_unavailable'
      msg = 'SEF nije dostupan, pokušajte ponovo.'
    } else if (!res.ok) {
      status = 422; code = 'sef_refused'
      msg = `SEF je odbio odluku (${res.status})${detail ? `: ${detail}` : '.'}`
    } else {
      // 200 without Success: true is a refusal, not a decision.
      status = 422; code = 'sef_refused'
      msg = `SEF nije upisao odluku${detail ? `: ${detail}` : '.'}`
    }
    await record({
      http_status: res.status, success: false, sef_status: answer.status,
      response, error: msg,
    })
    return fail(status, code, msg, { http_status: res.status })
  }

  // ── SEF SAID YES ────────────────────────────────────────────────────────
  const sefStatus = answer.status ?? (accepted ? 'Approved' : 'Rejected')
  const recordErr = await record({ http_status: res.status, success: true, sef_status: sefStatus, response })

  const { data: me } = await supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle()
  const decidedByName = me?.full_name || me?.email || user.email || null
  const decidedAt = new Date().toISOString()

  const { error: saveErr } = await supabase.from('sef_inbox').update({
    sef_decision: accepted ? 'accepted' : 'rejected',
    sef_decision_comment: comment || null,
    sef_decided_at: decidedAt,
    sef_decided_by: user.id,
    sef_decided_by_name: decidedByName,
    sef_decision_response: response,
    sef_status: sefStatus,
  }).eq('id', row.id)

  // SEF has the decision either way; what failed is our copy of it. Said so,
  // and NOT as something to retry: a second call would be a second decision.
  if (saveErr) {
    return fail(500, 'saved_on_sef_only',
      `SEF je upisao odluku (status ${sefStatus}), ali ona nije sačuvana kod nas: ${saveErr.message}. Ne ponavljajte — status će se osvežiti pri sledećem povlačenju.`,
      { sef_status: sefStatus })
  }

  return json({
    ok: true,
    decision: accepted ? 'accepted' : 'rejected',
    sef_status: sefStatus,
    invoice_number: answer.invoiceNumber,
    decided_at: decidedAt,
    decided_by_name: decidedByName,
    ...(recordErr ? { record_error: `Pokušaj nije zapisan u istoriju: ${recordErr}` } : {}),
  })
})
