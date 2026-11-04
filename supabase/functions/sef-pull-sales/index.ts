import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  PULLED_STATUSES, MAX_NEW_PER_PASS, isVoided, idsUrl, readIds, readStatus, readChanges,
  headerFromUbl, slimXml, ublPdfAttachments, salesPdfPath, salesAttachmentPath,
  refreshTargets, salesRefusal,
} from './salesInvoice.ts'

// ─── Reading what the company issued ────────────────────────────────────────
//
// The issued-invoice twin of `sef-pull`. SEF has no overview for issued
// invoices, so a pass is: one list of ids per issued status (`ids`), then for
// every id not yet in the inbox its status, its document and its PDF, then a
// second look at the rows that dropped off the lists (an invoice that was
// stornoed or cancelled leaves them) and at the day's status changes.
//
// Reading an issued invoice marks nothing for anybody, unlike a received one,
// so this function may open documents; `sef-pull` still may not.
//
// Nothing is booked here. The rows land in the inbox, in the `sales`
// direction, and people decide what to do with them.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const PROVIDER = 'sef-sales'
const SEF_TIMEOUT_MS = 60_000
// Three calls per new invoice: a pass stops starting new ones after this long
// and says `more: true`, so the next pass takes up where it stopped.
const PASS_BUDGET_MS = 110_000

/** Thrown for a refusal that stops the whole pass: a dead key, a key without the role. */
class Refused extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const startedAt = Date.now()
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // WHO IS CALLING: as in `sef-pull`. Cron presents a service-role credential
  // (a legacy JWT or an `sb_secret_...` key, both real, not the same string);
  // a person presents a signed-in token and must be a member of the company.
  // The credential is spent on an admin endpoint rather than decoded, so its
  // signature is checked by the auth server and a forgery fails there.
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || ''

  // The `!== ''` guards are deliberate: a missing env var must not let an
  // absent Authorization header match an empty key.
  let allowed = (serviceKey !== '' && bearer === serviceKey)
             || (secretKey !== '' && bearer === secretKey)

  if (!allowed && bearer !== '') {
    const probe = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
    const { error: probeErr } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 })
    allowed = !probeErr
  }

  if (!allowed && bearer !== '') {
    const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
    if (!whoErr && who?.user) {
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
      if (!anonKey) return json({ error: 'Funkciji nedostaje SUPABASE_ANON_KEY.' }, 500)
      const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, anonKey, {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const member = await asCaller.rpc('is_member')
      if (member.error) return json({ error: 'Uloga nije mogla da se proveri.' }, 500)
      if (!(member.data === true)) return json({ error: 'SEF povlačenje pokreću samo članovi firme.' }, 403)
      allowed = true
    }
  }

  if (!allowed) return json({ error: 'Sign in first.' }, 401)

  const body = await req.json().catch(() => ({}))

  // A run is claimed, not inserted (see `sef-pull`): a second pass of the day
  // is not an error, and an overlapping call is a no-op. Its own account,
  // 'sef-sales', so a pass here never blocks the purchase pull.
  const syncDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date())
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_processor_sync', {
    p_date: syncDate, p_provider: 'sef-sales', p_account: '',
  })
  if (claimErr) {
    return json({ provider: PROVIDER, status: 'failed', error: `Could not claim the run: ${claimErr.message}` }, 500)
  }
  if (claimed === null || claimed === undefined) {
    return json({ provider: PROVIDER, skipped: true, message: 'Issued invoices are already being pulled. Nothing was touched.' })
  }
  const runId = claimed as number

  const close = async (patch: Record<string, unknown>) => {
    const { error } = await supabase.from('processor_sync_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId)
    return error ? { closed: false, closeError: error.message } : {}
  }

  // Nothing reads the response of a scheduled pass, so the run row is the only
  // record: every failure goes through here.
  const fail = async (message: string, status = 500) => {
    const closed = await close({ status: 'failed', error: message })
    return json({ provider: PROVIDER, status: 'failed', error: message, ...closed }, status)
  }

  try {
    const { data: creds, error: credErr } = await supabase
      .from('integration_credentials').select('*')
      .eq('provider', 'sef').eq('is_active', true).limit(1)
    if (credErr) return await fail(`Could not read the SEF credentials: ${credErr.message}`)

    const cred = creds?.[0]
    if (!cred?.api_key) {
      return await fail('No active SEF credentials. Add a row to integration_credentials with provider = sef.', 400)
    }
    const extra = (cred.extra || {}) as { company_id?: string; base_url?: string }
    if (!extra.company_id) {
      return await fail('The SEF credential row carries no company_id in its `extra` column, so there is nothing to file the invoices under.', 400)
    }
    const companyId = extra.company_id
    const base = extra.base_url || 'https://efaktura.mfin.gov.rs/api/publicApi'

    // The window is Postgres's, the same as the purchase pull's.
    const { data: win, error: winErr } = await supabase
      .rpc('sef_pull_window', { p_from: body.from ?? null, p_to: body.to ?? null })
    const w = Array.isArray(win) ? win[0] : win
    if (winErr || !w) return await fail(`Could not work out the window: ${winErr?.message}`)

    if (w.date_from > w.date_to) {
      const note = `The configured floor (${w.date_from}) is later than the end of the window (${w.date_to}), so SEF was not asked.`
      const closed = await close({
        status: 'complete', transactions: 0, period_from: w.date_from, period_to: w.date_to, error: note,
      })
      return json({
        provider: PROVIDER, status: 'complete', listed: 0, inserted: 0, refreshed: 0, more: false,
        from: w.date_from, to: w.date_to, note, ...closed,
      })
    }

    // ── One SEF call ──────────────────────────────────────────────────────
    // A refusal that stops everything is thrown as `Refused`; any other
    // failure is the caller's to handle, since one broken invoice must not
    // stop the rest.
    const sef = async (method: 'GET' | 'POST', path: string): Promise<Response> => {
      let res: Response
      try {
        res = await fetch(`${base}${path}`, { method, headers: { ApiKey: cred.api_key }, signal: AbortSignal.timeout(SEF_TIMEOUT_MS) })
      } catch (e) {
        throw new Error(`SEF could not be reached: ${e instanceof Error ? e.message : String(e)}`)
      }
      const refusal = salesRefusal(res.status)
      if (refusal) throw new Refused(refusal, res.status)
      return res
    }

    // ── 1. WHAT SEF LISTS ─────────────────────────────────────────────────
    // One list per issued status. Never Cancelled, Storno or Rejected.
    const listedStatus = new Map<number, string>()
    for (const status of PULLED_STATUSES) {
      const res = await sef('POST', idsUrl('', status, w.date_from, w.date_to))
      if (!res.ok) return await fail(`SEF answered ${res.status} for status ${status}: ${(await res.text()).slice(0, 500)}`)
      const ids = readIds(await res.json().catch(() => null))
      for (const id of ids) if (!listedStatus.has(id)) listedStatus.set(id, status)
    }
    const listed = new Set(listedStatus.keys())

    // ── 2. WHAT THE INBOX ALREADY HAS ─────────────────────────────────────
    type Known = { sef_invoice_id: number; sef_status: string | null; ubl_fetched_at: string | null }
    const knownById = new Map<number, Known>()
    const listedIds = [...listed]
    for (let i = 0; i < listedIds.length; i += 200) {
      const { data, error } = await supabase.from('sef_inbox')
        .select('sef_invoice_id, sef_status, ubl_fetched_at')
        .eq('company_id', companyId).eq('direction', 'sales')
        .in('sef_invoice_id', listedIds.slice(i, i + 200))
      if (error) return await fail(`Could not read the inbox: ${error.message}`)
      for (const k of (data || []) as Known[]) knownById.set(Number(k.sef_invoice_id), k)
    }

    // Brand-new ids first; then rows an earlier pass stored but could not
    // finish (no document yet). Capped: the rest is the next pass's.
    const fresh = listedIds.filter(id => !knownById.has(id))
    const unfinished = listedIds.filter(id => knownById.has(id) && !knownById.get(id)!.ubl_fetched_at)
    const wanted = [...fresh, ...unfinished]
    const toFetch = wanted.slice(0, MAX_NEW_PER_PASS)
    let more = wanted.length > toFetch.length

    // ── 3. NEW INVOICES: STATUS, DOCUMENT, PDF ────────────────────────────
    let inserted = 0
    const problems: string[] = []
    for (const id of toFetch) {
      if (Date.now() - startedAt > PASS_BUDGET_MS) { more = true; break }
      try {
        const r = await pullOne(id, listedStatus.get(id) ?? null)
        if (r === 'inserted') inserted++
      } catch (e) {
        if (e instanceof Refused) throw e
        problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    async function pullOne(id: number, listedAs: string | null): Promise<'inserted' | 'kept' | 'skipped'> {
      const sres = await sef('GET', `/sales-invoice?invoiceId=${id}`)
      if (!sres.ok) throw new Error(`status: SEF answered ${sres.status}`)
      const st = readStatus(await sres.json().catch(() => null))
      const status = st?.status ?? listedAs
      // Cancelled between the list and now: not pulled, the next pass will not list it.
      if (isVoided(status)) return 'skipped'

      const xres = await sef('GET', `/sales-invoice/xml?invoiceId=${id}`)
      if (!xres.ok) throw new Error(`document: SEF answered ${xres.status}`)
      const xml = await xres.text()
      // A 200 is not a promise that a document came back (a WAF page, a truncated body).
      if (!xml.trimStart().startsWith('<') || !(xml.includes('<Invoice') || xml.includes('<CreditNote'))) {
        throw new Error('document: SEF returned something that is not an invoice document')
      }
      const h = headerFromUbl(xml)

      const { data: merged, error: upErr } = await supabase.rpc('sef_sales_upsert', {
        p_company_id: companyId,
        p_rows: [{
          sefInvoiceId: id, status, globUniqId: st?.globUniqId ?? null, cirInvoiceId: st?.cirInvoiceId ?? null,
          comment: st?.comment ?? null, ...h,
        }],
      })
      if (upErr) throw new Error(`the inbox refused the row: ${upErr.message}`)
      const m = Array.isArray(merged) ? merged[0] : merged

      const { data: row, error: rowErr } = await supabase.from('sef_inbox').select('id')
        .eq('company_id', companyId).eq('direction', 'sales').eq('sef_invoice_id', id).maybeSingle()
      if (rowErr || !row) throw new Error(`the row could not be found after it was stored: ${rowErr?.message ?? 'missing'}`)

      // The PDF: SEF's own rendering of the invoice. A failure is noted on the
      // row and never costs the document.
      const pdf = await keepPdfs(row.id, id, xml)
      const { error: saveErr } = await supabase.from('sef_inbox').update({
        ubl_xml: slimXml(xml),
        ubl_fetched_at: new Date().toISOString(),
        ...(pdf.saved ?? {}),
        ...(pdf.error ? { pdf_note: pdf.error } : {}),
      }).eq('id', row.id)
      if (saveErr) throw new Error(`the document could not be stored: ${saveErr.message}`)
      return (m?.inserted ?? 0) > 0 ? 'inserted' : 'kept'
    }

    async function keepPdfs(inboxId: string, sefId: number, xml: string) {
      const problems: string[] = []
      let saved: Record<string, unknown> | undefined
      try {
        const pres = await sef('GET', `/sales-invoice/pdf?invoiceId=${sefId}`)
        if (!pres.ok) {
          problems.push(`PDF računa nije preuzet (SEF ${pres.status}).`)
        } else {
          const bytes = new Uint8Array(await pres.arrayBuffer())
          if (!isPdf(bytes)) {
            problems.push('PDF računa nije preuzet (odgovor nije PDF).')
          } else {
            const path = salesPdfPath(companyId, sefId)
            const { error } = await supabase.storage.from('sef-pdf')
              .upload(path, bytes, { contentType: 'application/pdf', upsert: true })
            if (error) problems.push(`PDF računa nije sačuvan: ${error.message}`)
            else saved = {
              pdf_path: path, pdf_sha256: await sha256Hex(bytes), pdf_bytes: bytes.length,
              pdf_kind: 'sef_rendering', pdf_saved_at: new Date().toISOString(),
            }
          }
        }

        const rows = []
        for (const a of ublPdfAttachments(xml)) {
          const abytes = toBytes(a.base64)
          const path = salesAttachmentPath(companyId, sefId, a.n)
          const { error } = await supabase.storage.from('sef-pdf')
            .upload(path, abytes, { contentType: 'application/pdf', upsert: true })
          if (error) { problems.push(`Prilog ${a.n} nije sačuvan: ${error.message}`); continue }
          rows.push({
            inbox_id: inboxId, company_id: companyId, n: a.n, path,
            filename: a.filename, description: a.description,
            sha256: await sha256Hex(abytes), bytes: abytes.length, saved_at: new Date().toISOString(),
          })
        }
        if (rows.length) {
          const { error } = await supabase.from('sef_inbox_attachments').upsert(rows, { onConflict: 'path' })
          if (error) problems.push(`Prilozi nisu zabeleženi: ${error.message}`)
        }
      } catch (e) {
        if (e instanceof Refused) throw e
        problems.push(`PDF nije sačuvan: ${e instanceof Error ? e.message : String(e)}`)
      }
      return { saved, ...(problems.length ? { error: problems.join(' ') } : {}) }
    }

    // ── 4. WHAT CHANGED ON ROWS ALREADY PULLED ────────────────────────────
    // (a) a listed row whose status differs from the one stored;
    // (b) a known row in the window that no list carries any more (it was
    //     stornoed, cancelled or rejected) — asked about one by one;
    // (c) today's and yesterday's status changes, as SEF reports them.
    // All of it goes through `sef_sales_status`, which touches only existing
    // sales rows and never invents one.
    const updates = new Map<number, { sefInvoiceId: number; status: string | null; comment: string | null }>()
    for (const [id, k] of knownById) {
      const nowStatus = listedStatus.get(id)
      if (nowStatus && nowStatus !== k.sef_status) updates.set(id, { sefInvoiceId: id, status: nowStatus, comment: null })
    }

    const { data: inWindow, error: winRowsErr } = await supabase.from('sef_inbox')
      .select('sef_invoice_id, sef_status')
      .eq('company_id', companyId).eq('direction', 'sales')
      .gte('issue_date', w.date_from).lte('issue_date', w.date_to)
      .limit(2000)
    if (winRowsErr) return await fail(`Could not read the inbox: ${winRowsErr.message}`)
    const askAgain = new Set(refreshTargets(
      ((inWindow || []) as { sef_invoice_id: number; sef_status: string | null }[])
        .map(r => ({ sefInvoiceId: Number(r.sef_invoice_id), sefStatus: r.sef_status })),
      listed,
    ))

    // Today and yesterday, Belgrade. A status that became a voided one is
    // asked about too, for the comment SEF keeps with it.
    const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' })
      .format(new Date(Date.now() - offset * 86_400_000))
    for (const date of [day(0), day(1)]) {
      if (Date.now() - startedAt > PASS_BUDGET_MS) break
      try {
        const cres = await sef('POST', `/sales-invoice/changes?date=${date}`)
        if (!cres.ok) { problems.push(`changes ${date}: SEF answered ${cres.status}`); continue }
        for (const c of readChanges(await cres.json().catch(() => null))) {
          if (isVoided(c.status)) askAgain.add(c.invoiceId)
          else updates.set(c.invoiceId, { sefInvoiceId: c.invoiceId, status: c.status, comment: null })
        }
      } catch (e) {
        if (e instanceof Refused) throw e
        problems.push(`changes ${date}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    let asked = 0
    for (const id of askAgain) {
      if (asked >= MAX_NEW_PER_PASS || Date.now() - startedAt > PASS_BUDGET_MS) { more = true; break }
      asked++
      try {
        const sres = await sef('GET', `/sales-invoice?invoiceId=${id}`)
        if (!sres.ok) { problems.push(`${id}: status: SEF answered ${sres.status}`); continue }
        const st = readStatus(await sres.json().catch(() => null))
        if (st?.status) updates.set(id, { sefInvoiceId: id, status: st.status, comment: st.comment })
      } catch (e) {
        if (e instanceof Refused) throw e
        problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    let refreshed = 0
    if (updates.size > 0) {
      const { data: n, error: stErr } = await supabase
        .rpc('sef_sales_status', { p_company_id: companyId, p_updates: [...updates.values()] })
      if (stErr) return await fail(`The inbox refused the status changes: ${stErr.message}`)
      refreshed = Number(n ?? 0)
    }

    const closed = await close({
      status: 'complete',
      transactions: listed.size,
      period_from: w.date_from, period_to: w.date_to,
      error: problems.length ? `${problems.length} problem(s): ${problems.slice(0, 5).join('; ')}`.slice(0, 1000) : null,
    })

    return json({
      provider: PROVIDER, status: 'complete',
      listed: listed.size, inserted, refreshed, more,
      from: w.date_from, to: w.date_to,
      ...(problems.length ? { problems: problems.length } : {}),
      ...closed,
    })
  } catch (e) {
    // A key SEF refuses stops the pass with the status that says which kind of refusal.
    if (e instanceof Refused) return await fail(e.message, e.httpStatus)
    return await fail(String((e as Error)?.message || e))
  }
})

// ─── Bytes ──────────────────────────────────────────────────────────────────

const isPdf = (b: Uint8Array) =>
  b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d

function toBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('')
}
