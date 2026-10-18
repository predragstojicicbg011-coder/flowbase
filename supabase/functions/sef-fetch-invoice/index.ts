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
//
// The one exception is asked for by name: `{ inbox_id, refetch_pdf: true }`
// fetches the document again for its PDFs only, and only for an invoice that
// is no longer New on SEF (an already-seen document stays as it is there).
// It never touches the stored XML or the row's state. Never more than one
// SEF call per request, either way.

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

  const body = await req.json().catch(() => ({})) as { id?: string; inbox_id?: string; refetch_pdf?: boolean }
  const id = body.inbox_id || body.id
  if (!id) return json({ error: 'No row id.' }, 400)
  const refetch = body.refetch_pdf === true

  const { data: row, error: rowErr } = await supabase
    .from('sef_inbox')
    .select('id, company_id, sef_invoice_id, state, sef_status, ubl_xml, pdf_path, pdf_kind, pdf_note')
    .eq('id', id).single()
  if (rowErr || !row) return json({ error: 'No such row in the inbox.' }, 404)

  // ── The repair: the PDFs again, for a row that has already been opened ──
  //
  // Rows opened before 20261019100000 kept the supplier's attachment (often a
  // delivery note) as their PDF, and the stored XML had every PDF stripped.
  // The invoice can only come from the document again. That is a second fetch
  // of something SEF has already marked Seen — it changes nothing there — so
  // it is allowed ONLY when SEF's status is known and is not New. A New
  // invoice would be marked Seen by it, behind the accounting firm's back.
  //
  // It touches the PDFs and nothing else: not `ubl_xml`, not `state`, not
  // `ubl_fetched_at`. SEF is still asked at most once per request.
  if (refetch) {
    if (!row.ubl_xml) {
      return json({ error: 'Faktura još nije otvorena. Otvorite je — PDF računa se čuva pri otvaranju.' }, 409)
    }
    const status = String(row.sef_status ?? '').trim()
    if (!status) {
      return json({ error: 'SEF status fakture nije poznat, pa se dokument ne preuzima ponovo. Povucite sanduče pa pokušajte opet.' }, 409)
    }
    if (status.toLowerCase() === 'new') {
      return json({ error: 'Faktura je na SEF-u još nova; ponovno preuzimanje bi je označilo kao pregledanu, pa se ne radi.' }, 409)
    }

    const doc = await fetchDocument(supabase, row.sef_invoice_id)
    if (doc instanceof Response) return doc
    const xml = doc.xml

    // The document must be the one this row is. The envelope names it.
    const named = /<env:PurchaseInvoiceId>\s*([^<\s]+)\s*<\/env:PurchaseInvoiceId>/.exec(xml)?.[1]
    if (named && named !== String(row.sef_invoice_id)) {
      return json({ error: `SEF returned the document of invoice ${named}, not ${row.sef_invoice_id}. Nothing was changed.` }, 502)
    }

    const kept = await keepPdfs(supabase, row.id, row.company_id, row.sef_invoice_id, xml)
    if (!kept.saved) {
      return json({ error: kept.error || 'SEF document carries no PDF. Nothing was changed.' }, 502)
    }
    const note = kept.saved.pdf_kind === 'sef_rendering'
      ? 'Ponovo preuzeto sa SEF-a radi računa (umesto priloga)'
      : 'Ponovo preuzeto sa SEF-a; dokument nema SEF-ov prikaz računa, pa je glavni PDF i dalje prilog'
    const { error: saveErr } = await supabase.from('sef_inbox')
      .update({ ...kept.saved, pdf_note: note })
      .eq('id', id)
    if (saveErr) return json({ error: `Fetched, but could not record it: ${saveErr.message}` }, 500)

    return json({
      refetched: true,
      pdf_path: kept.saved.pdf_path,
      pdf_kind: kept.saved.pdf_kind,
      attachments: kept.attachments,
      pdf_note: note,
      ...(kept.error ? { pdf_error: kept.error } : {}),
    })
  }

  // Already fetched: served from what is stored, and SEF is not asked again.
  // A row whose PDF is missing or is only an attachment is mended by the
  // repair above, which the person asks for knowingly.
  if (row.ubl_xml) {
    return json({
      ubl_xml: row.ubl_xml,
      already_had_it: true,
      pdf_path: row.pdf_path ?? null,
      pdf_kind: row.pdf_kind ?? null,
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

  const doc = await fetchDocument(supabase, row.sef_invoice_id)
  if (doc instanceof Response) return doc
  const xml = doc.xml

  // Base64 PDFs ride along in a document — the envelope's rendering of the
  // invoice (`env:DocumentPdf`, always) and whatever the supplier attached
  // (`cbc:EmbeddedDocumentBinaryObject`, zero or more). They are kept, in the
  // private `sef-pdf` bucket, BEFORE they are stripped: this is the only
  // moment their bytes exist here. See `keepPdfs` below.
  const pdf = await keepPdfs(supabase, row.id, row.company_id, row.sef_invoice_id, xml)

  // Together the PDFs are most of the document, so they are not stored in the
  // XML column. The elements stay, so what is stored is still a whole
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
    pdf_kind: pdf.saved?.pdf_kind ?? null,
    attachments: pdf.attachments,
    ...(pdf.error ? { pdf_error: pdf.error } : {}),
  })
})

// ─── The one SEF call ───────────────────────────────────────────────────────
//
// Both the first open and the repair go through here, to the same endpoint,
// once per request. Returns the document, or the Response to send instead.

async function fetchDocument(
  supabase: ReturnType<typeof createClient>,
  sefInvoiceId: number | string,
): Promise<{ xml: string } | Response> {
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
    res = await fetch(`${base}/purchase-invoice/xml?invoiceId=${sefInvoiceId}`,
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

  return { xml }
}

// ─── The PDFs ───────────────────────────────────────────────────────────────
//
// A minimal copy of `src/services/sef/sefPdf.ts`, which is where the choice is
// tested: the edge functions share no code with the app. Change both together.
//
// THE RULE: the main PDF is SEF's rendering of the invoice whenever there is
// one; a supplier attachment stands in only when it is missing. Every supplier
// PDF attachment is kept too, as `<company_id>/<sef_invoice_id>/prilog-<n>.pdf`
// with a row in `sef_inbox_attachments`. A candidate that does not decode to
// `%PDF-` (base64 `JVBERi0`) is skipped.

type PdfKind = 'supplier_attachment' | 'sef_rendering'

interface EnvelopeAttachment { n: number; filename: string | null; description: string | null; base64: string }

const unescapeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function textOf(fragment: string, tag: string): string | null {
  const m = new RegExp(`<cbc:${tag}\\b[^>]*>([^<]*)</cbc:${tag}>`).exec(fragment)
  const t = m ? unescapeXml(m[1]).trim() : ''
  return t || null
}

function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  const v = m ? unescapeXml(m[1] ?? m[2] ?? '').trim() : ''
  return v || null
}

function envelopeAttachments(xml: string): EnvelopeAttachment[] {
  const out: EnvelopeAttachment[] = []
  const reference = /<cac:AdditionalDocumentReference\b[^>]*>([\s\S]*?)<\/cac:AdditionalDocumentReference>/g
  for (const ref of xml.matchAll(reference)) {
    const body = ref[1]
    const bin = /<cbc:EmbeddedDocumentBinaryObject([^>]*)>([^<]*)<\/cbc:EmbeddedDocumentBinaryObject>/.exec(body)
    if (!bin) continue
    const b64 = bin[2].replace(/\s+/g, '')
    if (!/mimeCode\s*=\s*["']application\/pdf["']/i.test(bin[1]) || !b64.startsWith('JVBERi0')) continue
    const at = body.search(/<cac:Attachment\b/)
    const head = at < 0 ? body : body.slice(0, at)
    out.push({
      n: out.length + 1,
      filename: attrOf(bin[1], 'filename') ?? textOf(head, 'ID'),
      description: textOf(body, 'DocumentDescription') ?? textOf(body, 'DocumentType'),
      base64: b64,
    })
  }
  return out
}

function extractEnvelopePdfs(xml: string): { main: { kind: PdfKind; base64: string } | null; attachments: EnvelopeAttachment[] } {
  const attachments = envelopeAttachments(xml)
  const r = /<env:DocumentPdf[^>]*>([^<]*)<\/env:DocumentPdf>/.exec(xml)
  const rendering = r ? r[1].replace(/\s+/g, '') : ''
  const main = rendering.startsWith('JVBERi0')
    ? { kind: 'sef_rendering' as const, base64: rendering }
    : attachments[0] ? { kind: 'supplier_attachment' as const, base64: attachments[0].base64 } : null
  return { main, attachments }
}

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

interface KeptPdfs {
  saved?: { pdf_path: string; pdf_sha256: string; pdf_bytes: number; pdf_kind: PdfKind; pdf_saved_at: string }
  /** How many attachments are now kept for the row. */
  attachments: number
  error?: string
}

// Never throws: whatever goes wrong here is reported beside the XML, and the
// XML is stored regardless. The main PDF and the attachments fail separately:
// a lost attachment never costs the invoice.
async function keepPdfs(
  supabase: ReturnType<typeof createClient>,
  inboxId: string, companyId: string, sefInvoiceId: number | string, xml: string,
): Promise<KeptPdfs> {
  const problems: string[] = []
  let saved: KeptPdfs['saved']
  let kept = 0
  try {
    const { main, attachments } = extractEnvelopePdfs(xml)

    if (main) {
      const bytes = toBytes(main.base64)
      // `<company_id>/<sef_invoice_id>.pdf` — the convention 20261018120000 names.
      const path = `${companyId}/${sefInvoiceId}.pdf`
      const { error } = await supabase.storage.from('sef-pdf')
        .upload(path, bytes, { contentType: 'application/pdf', upsert: true })
      if (error) problems.push(`PDF računa nije sačuvan: ${error.message}`)
      else saved = {
        pdf_path: path, pdf_sha256: await sha256Hex(bytes), pdf_bytes: bytes.length,
        pdf_kind: main.kind, pdf_saved_at: new Date().toISOString(),
      }
    }

    const rows = []
    for (const a of attachments) {
      const bytes = toBytes(a.base64)
      const path = `${companyId}/${sefInvoiceId}/prilog-${a.n}.pdf`
      const { error } = await supabase.storage.from('sef-pdf')
        .upload(path, bytes, { contentType: 'application/pdf', upsert: true })
      if (error) { problems.push(`Prilog ${a.n} nije sačuvan: ${error.message}`); continue }
      rows.push({
        inbox_id: inboxId, company_id: companyId, n: a.n, path,
        filename: a.filename, description: a.description,
        sha256: await sha256Hex(bytes), bytes: bytes.length, saved_at: new Date().toISOString(),
      })
    }
    if (rows.length) {
      const { error } = await supabase.from('sef_inbox_attachments').upsert(rows, { onConflict: 'path' })
      if (error) problems.push(`Prilozi nisu zabeleženi: ${error.message}`)
      else kept = rows.length
    }
  } catch (e) {
    problems.push(`PDF nije sačuvan: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { saved, attachments: kept, ...(problems.length ? { error: problems.join(' ') } : {}) }
}
