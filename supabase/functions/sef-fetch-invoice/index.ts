import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── The one call that marks an invoice Seen ────────────────────────────────
//
// Separate from `sef-pull` so that "the scheduled job never fetches a
// document" is the absence of code rather than a rule somebody has to keep.
//
// It is called from one place: the owner pressing "Open and book" on a row,
// having been told what that does. An invoice he declines is never fetched,
// so it stays `New` in SEF for the accounting firm.
//
// SEF is asked for a document EXACTLY ONCE. The second open reads what is
// stored, so changing one's mind twice costs nothing and marks nothing.

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

  // The owner's browser.
  if (!allowed && bearer !== '') {
    const { data: who, error: whoErr } = await supabase.auth.getUser(bearer)
    allowed = !whoErr && !!who?.user
  }

  if (!allowed) return json({ error: 'Sign in first.' }, 401)

  const { id } = await req.json().catch(() => ({ id: null }))
  if (!id) return json({ error: 'No row id.' }, 400)

  const { data: row, error: rowErr } = await supabase
    .from('sef_inbox').select('id, company_id, sef_invoice_id, state, ubl_xml, pdf_path')
    .eq('id', id).single()
  if (rowErr || !row) return json({ error: 'No such row in the inbox.' }, 404)

  // Already fetched: served from what is stored, and SEF is not asked again —
  // not even for a PDF. A row opened before PDFs were kept had them stripped,
  // and they are gone; a second fetch would be a second thing SEF records.
  if (row.ubl_xml) {
    return json({
      ubl_xml: row.ubl_xml,
      already_had_it: true,
      pdf_path: row.pdf_path ?? null,
      ...(row.pdf_path ? {} : { pdf_note: 'PDF nije sačuvan (faktura otvorena pre ove izmene)' }),
    })
  }

  // A declined invoice must stay `New` in SEF, which is the promise the whole
  // feature rests on — the owner's accounting firm reads the same inbox. There
  // is no reason to fetch a document for a bill he has already said he does
  // not want, and doing it once spends that status for good.
  if (row.state === 'dismissed') {
    return json({ error: 'That invoice was declined. Put it back in the queue first if you mean to book it.' }, 409)
  }

  const { data: creds, error: credErr } = await supabase
    .from('integration_credentials').select('*')
    .eq('provider', 'sef').eq('is_active', true).limit(1)
  if (credErr) return json({ error: `Could not read the SEF credentials: ${credErr.message}` }, 500)

  const cred = creds?.[0]
  if (!cred?.api_key) return json({ error: 'No active SEF credentials.' }, 400)

  // `integration_credentials` is shared with Chargebee and Braintree and has no
  // column for either of these — `extra` is the jsonb slot for exactly this, and
  // no other provider uses it. Adding columns to a shared table for one
  // integration's sake is not worth it.
  const extra = (cred.extra || {}) as { base_url?: string }
  const base = extra.base_url || 'https://efaktura.mfin.gov.rs/api/publicApi'
  let res: Response
  try {
    // A hung connection would otherwise leave the owner waiting on the button
    // with no answer. Same bound as `sef-pull`.
    res = await fetch(`${base}/purchase-invoice/xml?invoiceId=${row.sef_invoice_id}`,
      { headers: { ApiKey: cred.api_key }, signal: AbortSignal.timeout(60_000) })
  } catch (e) {
    return json({ error: `SEF could not be reached: ${e instanceof Error ? e.message : String(e)}` }, 502)
  }

  // Same split as `sef-pull`, so the two read the same way side by side. A
  // 403 is not necessarily a dead key: it can be a key without permission for
  // incoming invoices, and the owner needs to know which to go and fix.
  if (res.status === 401) {
    return json({ error: 'SEF rejected the key. Check it in Settings → API Management and update integration_credentials.' }, 401)
  }
  if (res.status === 403) {
    return json({ error: 'SEF refused the request — the key may lack permission for incoming invoices.' }, 403)
  }
  if (!res.ok) {
    return json({ error: `SEF answered ${res.status}: ${(await res.text()).slice(0, 500)}` }, 502)
  }

  const xml = await res.text()

  // An empty body is not a document. Stored, it leaves `ubl_xml` falsy and the
  // next open fetches again — so the one thing this function promises, that
  // SEF is asked exactly once per invoice, quietly stops being true while
  // every open spends another call. A whitespace-only body is worse: truthy,
  // so it would be served as a document for ever.
  if (!xml.trim()) {
    return json({ error: 'SEF returned an empty document. Nothing was stored; try again.' }, 502)
  }

  // A 200 is not a promise that what came back is a document — a WAF page, an
  // error page or a truncated response all arrive as one. Stored, it is
  // cached for ever: the invoice is already Seen, every later open returns
  // the same junk, and `authenticated` cannot clear `ubl_xml` because that
  // column is deliberately not writable from the browser.
  if (!xml.trimStart().startsWith('<')
      || !(xml.includes('<Invoice') || xml.includes('<CreditNote'))) {
    return json({ error: 'SEF returned something that is not an invoice document. Nothing was stored; try again.' }, 502)
  }

  // Two base64 PDFs ride along in a document — the envelope's rendered copy
  // (`env:DocumentPdf`, always) and the supplier's own attachment
  // (`cbc:EmbeddedDocumentBinaryObject`, when he sent one). One is kept, in
  // the private `sef-pdf` bucket, BEFORE they are stripped: this is the only
  // moment its bytes exist here. See `keepPdf` below.
  const pdf = await keepPdf(supabase, row.company_id, row.sef_invoice_id, xml)

  // Together the two PDFs are most of the 150 KB, so they are not stored in
  // the XML column. The elements stay, so what is stored is still a whole
  // document.
  const slim = xml
    .replace(/(<env:DocumentPdf[^>]*>)[^<]*(<\/env:DocumentPdf>)/g, '$1$2')
    .replace(/(<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]*(<\/cbc:EmbeddedDocumentBinaryObject>)/g, '$1$2')

  // Stored before it is returned. If this write fails the caller is told,
  // rather than being handed a document the next open would fetch again —
  // and a second fetch is a second thing SEF records.
  // The PDF columns go in the SAME update as the XML, and only when the upload
  // succeeded. A failed upload leaves them null and is reported; it never
  // costs the XML, which is what the books are made from.
  const { error: saveErr } = await supabase.from('sef_inbox')
    .update({
      ubl_xml: slim,
      ubl_fetched_at: new Date().toISOString(),
      ...(pdf.saved ?? {}),
    })
    .eq('id', id)
  if (saveErr) return json({ error: `Fetched, but could not store it: ${saveErr.message}` }, 500)

  return json({
    ubl_xml: slim,
    already_had_it: false,
    pdf_path: pdf.saved?.pdf_path ?? null,
    ...(pdf.error ? { pdf_error: pdf.error } : {}),
  })
})

// ─── The PDF ────────────────────────────────────────────────────────────────
//
// A minimal copy of `src/services/sef/sefPdf.ts`, which is where the choice is
// tested: the edge functions share no code with the app. Change both together.
//
// The supplier's own attachment is preferred — it is the document he issued —
// and SEF's rendering is the fallback. A candidate that does not decode to
// `%PDF-` (base64 `JVBERi0`) is skipped.

type PdfKind = 'supplier_attachment' | 'sef_rendering'

function pickEnvelopePdf(xml: string): { kind: PdfKind; base64: string } | null {
  const attachment = /<cbc:EmbeddedDocumentBinaryObject([^>]*)>([^<]*)<\/cbc:EmbeddedDocumentBinaryObject>/g
  for (const m of xml.matchAll(attachment)) {
    const b64 = m[2].replace(/\s+/g, '')
    if (/mimeCode\s*=\s*["']application\/pdf["']/i.test(m[1]) && b64.startsWith('JVBERi0')) {
      return { kind: 'supplier_attachment', base64: b64 }
    }
  }
  const r = /<env:DocumentPdf[^>]*>([^<]*)<\/env:DocumentPdf>/.exec(xml)
  const b64 = r ? r[1].replace(/\s+/g, '') : ''
  return b64.startsWith('JVBERi0') ? { kind: 'sef_rendering', base64: b64 } : null
}

interface KeptPdf {
  saved?: { pdf_path: string; pdf_sha256: string; pdf_bytes: number; pdf_kind: PdfKind; pdf_saved_at: string }
  error?: string
}

// Never throws: whatever goes wrong here is reported beside the XML, and the
// XML is stored regardless.
async function keepPdf(
  supabase: ReturnType<typeof createClient>,
  companyId: string, sefInvoiceId: number | string, xml: string,
): Promise<KeptPdf> {
  try {
    const pick = pickEnvelopePdf(xml)
    if (!pick) return {}

    const bin = atob(pick.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const sha256 = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('')

    // `<company_id>/<sef_invoice_id>.pdf` — the convention the migration names.
    const path = `${companyId}/${sefInvoiceId}.pdf`
    const { error } = await supabase.storage.from('sef-pdf')
      .upload(path, bytes, { contentType: 'application/pdf', upsert: true })
    if (error) return { error: `PDF nije sačuvan: ${error.message}` }

    return {
      saved: {
        pdf_path: path, pdf_sha256: sha256, pdf_bytes: bytes.length,
        pdf_kind: pick.kind, pdf_saved_at: new Date().toISOString(),
      },
    }
  } catch (e) {
    return { error: `PDF nije sačuvan: ${e instanceof Error ? e.message : String(e)}` }
  }
}
