// ─── Issued invoices, as SEF gives them ─────────────────────────────────────
//
// The pure half of `sef-pull-sales`: which statuses are pulled, the shapes of
// SEF's answers, the header read off the UBL document, the paths the files
// are kept at. No Deno APIs, so the app's tests can read it too (like
// `lookup-pib/nbsRegister.ts`). The function itself is `index.ts`.
//
// SEF has no overview for issued invoices. What exists is a list of ids per
// status (`ids`), one call per invoice for its status (`sales-invoice`), its
// document (`xml`) and its rendering (`pdf`), and the day's status changes
// (`changes`). Reading an issued invoice marks nothing in anybody's mailbox,
// unlike the purchase side.

/** The five statuses of an invoice that was really issued. */
export const PULLED_STATUSES = ['Sent', 'Approved', 'Paid', 'OverDue', 'Archived'] as const
/** Never pulled. A row already pulled that turns into one of these keeps the status. */
export const VOIDED_STATUSES = ['Cancelled', 'Storno', 'Rejected'] as const
/** Each new invoice costs three SEF calls; the rest waits for the next pass. */
export const MAX_NEW_PER_PASS = 40

export function isVoided(status: string | null | undefined): boolean {
  const s = String(status ?? '').trim().toLowerCase()
  return VOIDED_STATUSES.some(v => v.toLowerCase() === s)
}

export function idsUrl(base: string, status: string, from: string, to: string): string {
  return `${base}/sales-invoice/ids?status=${status}&dateFrom=${from}&dateTo=${to}`
}

// ── SEF's JSON answers ─────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A key whatever its case: SEF's casing has differed between its services. */
function pick(o: unknown, key: string): unknown {
  if (!isObject(o)) return undefined
  const k = Object.keys(o).find(x => x.toLowerCase() === key.toLowerCase())
  return k === undefined ? undefined : o[k]
}

function asId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

function asText(v: unknown): string | null {
  if (typeof v === 'string') { const t = v.trim(); return t || null }
  if (typeof v === 'number') return String(v)
  return null
}

export function readIds(body: unknown): number[] {
  const list = pick(body, 'SalesInvoiceIds')
  if (!Array.isArray(list)) return []
  const out: number[] = []
  for (const v of list) {
    const n = asId(v)
    if (n !== null && !out.includes(n)) out.push(n)
  }
  return out
}

export interface SalesStatus {
  invoiceId: number
  status: string | null
  globUniqId: string | null
  cirInvoiceId: string | null
  comment: string | null
}

export function readStatus(body: unknown): SalesStatus | null {
  const invoiceId = asId(pick(body, 'InvoiceId'))
  if (invoiceId === null) return null
  return {
    invoiceId,
    status: asText(pick(body, 'Status')),
    globUniqId: asText(pick(body, 'GlobUniqId')),
    cirInvoiceId: asText(pick(body, 'CirInvoiceId')),
    comment: asText(pick(body, 'StornoComment')) ?? asText(pick(body, 'CancelComment')),
  }
}

export function readChanges(body: unknown): { invoiceId: number; status: string }[] {
  if (!Array.isArray(body)) return []
  const out: { invoiceId: number; status: string }[] = []
  for (const r of body) {
    const invoiceId = asId(pick(r, 'SalesInvoiceId'))
    const status = asText(pick(r, 'NewInvoiceStatus'))
    if (invoiceId !== null && status) out.push({ invoiceId, status })
  }
  return out
}

// ── The header, off the UBL document ───────────────────────────────────────

export interface SalesHeader {
  documentNumber: string | null
  documentType: 'Invoice' | 'Prepayment' | 'CreditNote' | 'DebitNote' | null
  customerName: string | null
  customerVatNumber: string | null
  customerRegistrationNumber: string | null
  amount: number | null
  sumWithoutVat: number | null
  vatAmount: number | null
  currency: string | null
  issueDate: string | null
  deliveryDate: string | null
  dueDate: string | null
}

const unescapeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** First `<prefix:tag ...>text</prefix:tag>` inside a fragment. */
function textIn(fragment: string, tag: string): string | null {
  const m = new RegExp(`<(?:cbc|cac):${tag}\\b[^>]*>([^<]*)</(?:cbc|cac):${tag}>`).exec(fragment)
  const t = m ? unescapeXml(m[1]).trim() : ''
  return t || null
}

function blockOf(xml: string, tag: string): string {
  const m = new RegExp(`<cac:${tag}\\b[^>]*>([\\s\\S]*?)</cac:${tag}>`).exec(xml)
  return m ? m[1] : ''
}

function numberIn(fragment: string, tag: string): number | null {
  const t = textIn(fragment, tag)
  if (t === null || !/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null
  return Number(t)
}

function dateIn(fragment: string, tag: string): string | null {
  const t = textIn(fragment, tag)
  const m = t ? /^\d{4}-\d{2}-\d{2}/.exec(t) : null
  return m ? m[0] : null
}

const DOCUMENT_TYPES: Record<string, SalesHeader['documentType']> = {
  '380': 'Invoice', '386': 'Prepayment', '381': 'CreditNote', '383': 'DebitNote',
}

export function headerFromUbl(xml: string): SalesHeader {
  // The embedded PDFs are most of a document and can hold anything; the header
  // is read from what is left.
  const doc = xml.replace(/(<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]*(<\/cbc:EmbeddedDocumentBinaryObject>)/g, '$1$2')

  const customer = blockOf(doc, 'AccountingCustomerParty')
  const legal = blockOf(customer, 'PartyLegalEntity')
  const taxScheme = blockOf(customer, 'PartyTaxScheme')
  const vat = (textIn(taxScheme, 'CompanyID') ?? textIn(customer, 'EndpointID') ?? '')
    .replace(/^RS/i, '').trim()

  const totals = blockOf(doc, 'LegalMonetaryTotal')
  // The first TaxTotal is the document's; its subtotals come after its own amount.
  const taxTotal = blockOf(doc, 'TaxTotal')
  const head = doc.slice(0, doc.search(/<cac:AccountingSupplierParty\b/) >= 0
    ? doc.search(/<cac:AccountingSupplierParty\b/) : undefined)

  return {
    documentNumber: textIn(head, 'ID'),
    documentType: DOCUMENT_TYPES[textIn(doc, 'InvoiceTypeCode') ?? textIn(doc, 'CreditNoteTypeCode') ?? ''] ?? null,
    customerName: textIn(legal, 'RegistrationName') ?? textIn(blockOf(customer, 'PartyName'), 'Name'),
    customerVatNumber: vat || null,
    customerRegistrationNumber: textIn(legal, 'CompanyID'),
    amount: numberIn(totals, 'TaxInclusiveAmount'),
    sumWithoutVat: numberIn(totals, 'TaxExclusiveAmount'),
    vatAmount: numberIn(taxTotal, 'TaxAmount'),
    currency: textIn(head, 'DocumentCurrencyCode'),
    issueDate: dateIn(head, 'IssueDate'),
    deliveryDate: dateIn(blockOf(doc, 'Delivery'), 'ActualDeliveryDate'),
    dueDate: dateIn(head, 'DueDate') ?? dateIn(blockOf(doc, 'PaymentMeans'), 'PaymentDueDate'),
  }
}

// ── The PDFs ───────────────────────────────────────────────────────────────

/** Empties the base64 PDFs, leaving their elements, as `sef-fetch-invoice` does. */
export function slimXml(xml: string): string {
  return xml
    .replace(/(<env:DocumentPdf[^>]*>)[^<]*(<\/env:DocumentPdf>)/g, '$1$2')
    .replace(/(<cbc:EmbeddedDocumentBinaryObject[^>]*>)[^<]*(<\/cbc:EmbeddedDocumentBinaryObject>)/g, '$1$2')
}

function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  const v = m ? unescapeXml(m[1] ?? m[2] ?? '').trim() : ''
  return v || null
}

/** Every PDF the seller attached to the document. A candidate that does not decode to `%PDF-` is skipped. */
export function ublPdfAttachments(xml: string): { n: number; filename: string | null; description: string | null; base64: string }[] {
  const out: { n: number; filename: string | null; description: string | null; base64: string }[] = []
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
      filename: attrOf(bin[1], 'filename') ?? textIn(head, 'ID'),
      description: textIn(body, 'DocumentDescription') ?? textIn(body, 'DocumentType'),
      base64: b64,
    })
  }
  return out
}

/** Beside, never over, the purchase files: those are `<company>/<id>.pdf`. */
export const salesPdfPath = (companyId: string, id: number | string) => `${companyId}/sales/${id}.pdf`
export const salesAttachmentPath = (companyId: string, id: number | string, n: number) =>
  `${companyId}/sales/${id}/prilog-${n}.pdf`

// ── What to ask about again ────────────────────────────────────────────────

/**
 * Rows already pulled that this pass's lists no longer carry, and that are not
 * already voided: an invoice that left every list was stornoed, cancelled or
 * rejected, and only asking about it says which.
 */
export function refreshTargets(
  known: { sefInvoiceId: number; sefStatus: string | null }[],
  listed: ReadonlySet<number>,
): number[] {
  return known
    .filter(k => !listed.has(k.sefInvoiceId) && !isVoided(k.sefStatus))
    .map(k => k.sefInvoiceId)
}

// ── What SEF said about the key ────────────────────────────────────────────

export const SALES_FORBIDDEN =
  'SEF ključ nema pravo na izlazne fakture — u SEF portalu dodelite ulogu „Korisnik za izlazne dokumente“ korisniku ovog API ključa.'

const KEY_REFUSED =
  'SEF je odbio ključ — proverite da je ključ aktivan u SEF portalu (Podešavanja → API upravljanje)'

export function salesRefusal(httpStatus: number): string | null {
  if (httpStatus === 401) return KEY_REFUSED
  if (httpStatus === 403) return SALES_FORBIDDEN
  return null
}
