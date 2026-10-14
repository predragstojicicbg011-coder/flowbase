// ─── Reading a Serbian e-invoice ────────────────────────────────────────────
//
// The edge function stores the raw document and nothing else. Parsing happens
// HERE, in the browser, for three reasons and the third is the point:
//
//   it is tested with fixtures, the way `aftwrkParser` and `decodeUpload` are;
//   it can be re-run over XML already stored;
//   and when it mishandles some supplier's layout the fix is a deploy of this
//   application and NOT another call to SEF — so no effect on any status.
//
// `DOMParser` is the platform's, which jsdom provides in tests. No dependency.
//
// WHAT A REAL DOCUMENT LOOKS LIKE, which the first design did not know:
//
//   env:DocumentEnvelope / env:DocumentBody / Invoice | CreditNote
//
// The envelope carries SEF's own ids; the body is UBL, and its root has no
// prefix while everything under it is `cbc:` or `cac:`. Every path below is
// walked from that body root through DIRECT CHILDREN, never by searching the
// whole tree, because `cbc:ID` alone appears in a TaxScheme, in an item's
// identification, in a bank account and on every line, and the first hit in
// document order is not always the invoice number.

export interface UblLine {
  lineId: string
  name: string
  description: string | null
  quantity: number | null
  lineAmount: number | null
  vatPercent: number | null
}

export interface UblInvoice {
  invoiceNumber: string | null
  issueDate: string | null      // 'YYYY-MM-DD' — the TRUE issue date
  /**
   * `cac:Delivery/cbc:ActualDeliveryDate` — the date of supply.
   *
   * This, not the issue date, is what an invoice is booked on and what the
   * exchange rate is taken on. The two differ on most real bills: of the four
   * documents in hand, three were issued days after they were supplied.
   */
  deliveryDate: string | null
  dueDate: string | null
  currency: string | null
  typeCode: string | null       // '380' invoice, '381' credit note
  isCreditNote: boolean
  supplierName: string | null
  supplierVatNumber: string | null       // PIB, digits only
  supplierRegistrationNumber: string | null
  // WHO THE BILL IS ADDRESSED TO. The owner runs several companies, and which
  // of them a bill belongs to is written on the bill itself.
  customerName: string | null
  customerVatNumber: string | null       // PIB, digits only
  customerRegistrationNumber: string | null
  bankAccount: string | null    // as written; null when the bill names none
  /** `bankAccount` split on `;` and trimmed. A supplier may offer several in
   *  the one field, and which of them to pay is a decision, not a parse. */
  bankAccounts: string[]
  paymentReference: string | null
  paymentModel: string | null   // '97' from "(mod97) 1081…", else null
  net: number | null            // NEGATIVE for a credit note, like `vat` and `total`
  vat: number | null
  total: number | null
  sefPurchaseInvoiceId: string | null    // the envelope's id; what `sef_inbox.sef_invoice_id` holds
  lines: UblLine[]
}

// Elements are matched on LOCAL NAME. The body root has no prefix and the rest
// use `cbc:` and `cac:`, and a sender is free to choose others, so a lookup
// keyed on a prefix is how a parser starts failing on one supplier in ten.
const kids = (parent: Element | null, localName: string): Element[] =>
  parent ? Array.from(parent.children).filter(c => c.localName === localName) : []

const child = (parent: Element | null, ...path: string[]): Element | null => {
  let current = parent
  for (const name of path) {
    current = kids(current, name)[0] || null
    if (!current) return null
  }
  return current
}

const text = (e: Element | null): string | null => {
  const t = e?.textContent?.trim()
  return t ? t : null
}

const num = (e: Element | null): number | null => {
  const t = text(e)
  if (t === null) return null
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const digits = (s: string | null): string | null => {
  const d = (s || '').replace(/\D/g, '')
  return d || null
}

// A PaymentID may open with a marker naming the payment model, as in
// "(mod97) 108113652782", and the model is half of what a bank needs to match
// the payment. Without a marker the whole value is the reference.
const splitPaymentId = (raw: string | null): { model: string | null; reference: string | null } => {
  if (raw === null) return { model: null, reference: null }
  const m = /^\(mod\s*(\d+)\)\s*([\s\S]*)$/i.exec(raw)
  if (!m) return { model: null, reference: raw }
  return { model: m[1], reference: m[2].trim() || null }
}

// The first element in document order called Invoice or CreditNote. Found by
// search rather than by path so that a bare UBL document with no envelope, as
// the first design assumed, still parses.
const findBodyRoot = (doc: Document): Element | null => {
  const walk = (n: Element): Element | null => {
    if (n.localName === 'Invoice' || n.localName === 'CreditNote') return n
    for (const c of Array.from(n.children)) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  return doc.documentElement ? walk(doc.documentElement) : null
}

// invoice-sample.xml is a loan statement in EUR with TaxCurrencyCode RSD, and
// it carries a TaxTotal in each. The first one in the file is the dinar one,
// which would sit next to a total in euros — a figure that looks fine and is
// in the wrong unit. The right TaxTotal is the one in the document currency;
// the first is only a fallback for a document that has none in it.
const pickTaxAmount = (root: Element, currency: string | null): number | null => {
  const totals = kids(root, 'TaxTotal')
  const inDocumentCurrency = currency
    ? totals.find(t => child(t, 'TaxAmount')?.getAttribute('currencyID') === currency)
    : undefined
  return num(child(inDocumentCurrency || totals[0] || null, 'TaxAmount'))
}

const empty = (): UblInvoice => ({
  invoiceNumber: null, issueDate: null, dueDate: null, currency: null,
  typeCode: null, isCreditNote: false,
  supplierName: null, supplierVatNumber: null, supplierRegistrationNumber: null,
  customerName: null, customerVatNumber: null, customerRegistrationNumber: null,
  deliveryDate: null,
  bankAccount: null, bankAccounts: [], paymentReference: null, paymentModel: null,
  net: null, vat: null, total: null, sefPurchaseInvoiceId: null, lines: [],
})

export function parseUbl(xml: string): UblInvoice {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return empty()
  }

  const root = findBodyRoot(doc)
  if (!root) return empty()

  const envelope = doc.documentElement.localName === 'DocumentEnvelope' ? doc.documentElement : null
  const supplier = child(root, 'AccountingSupplierParty', 'Party')
  const customer = child(root, 'AccountingCustomerParty', 'Party')
  const payment = child(root, 'PaymentMeans')

  // A credit note names its type in `CreditNoteTypeCode`, not
  // `InvoiceTypeCode`. Reading only the second gives null, `isCreditNote`
  // false, and a credit booked as a positive cost. The root element is the
  // other witness, so a document that omits the code is still recognised.
  const typeCode = text(child(root, 'InvoiceTypeCode')) || text(child(root, 'CreditNoteTypeCode'))
  const isCreditNote = typeCode === '381' || root.localName === 'CreditNote'

  const currency = text(child(root, 'DocumentCurrencyCode'))

  // A credit note states every amount positive. Negating only the total would
  // leave net and VAT to be negated by whoever reads them, and a rule that
  // needs remembering in three places is one that gets forgotten in the
  // fourth. The sign is decided once, here, for the document.
  // Zero stays zero: `-Math.abs(0)` is negative zero, which `Object.is` and
  // JSON both tell apart from 0.
  const sign = (n: number | null): number | null =>
    n === null || n === 0 ? n : (isCreditNote ? -Math.abs(n) : n)

  const bankAccount = text(child(payment, 'PayeeFinancialAccount', 'ID'))

  const payId = splitPaymentId(text(child(payment, 'PaymentID')))

  const lines: UblLine[] = [...kids(root, 'InvoiceLine'), ...kids(root, 'CreditNoteLine')]
    .map(line => ({
      lineId: text(child(line, 'ID')) || '',
      name: text(child(line, 'Item', 'Name')) || '',
      // None of the three captured documents has one, so absence is the norm.
      description: text(child(line, 'Item', 'Description')),
      quantity: num(child(line, 'InvoicedQuantity') || child(line, 'CreditedQuantity')),
      lineAmount: num(child(line, 'LineExtensionAmount')),
      vatPercent: num(child(line, 'Item', 'ClassifiedTaxCategory', 'Percent')),
    }))

  return {
    invoiceNumber: text(child(root, 'ID')),
    issueDate: text(child(root, 'IssueDate')),
    deliveryDate: text(child(root, 'Delivery', 'ActualDeliveryDate')),
    dueDate: text(child(root, 'DueDate')),
    currency,
    typeCode,
    isCreditNote,
    supplierName: text(child(supplier, 'PartyName', 'Name')),
    // `RS100000004` in the document; `partners.tax_id` holds the bare digits.
    supplierVatNumber: digits(text(child(supplier, 'PartyTaxScheme', 'CompanyID'))),
    supplierRegistrationNumber: digits(text(child(supplier, 'PartyLegalEntity', 'CompanyID'))),
    // Read exactly like the supplier's, from the other party. `RS100000001`
    // in the document; `company_profiles.pib` holds the bare digits.
    customerName: text(child(customer, 'PartyName', 'Name')),
    customerVatNumber: digits(text(child(customer, 'PartyTaxScheme', 'CompanyID'))),
    customerRegistrationNumber: digits(text(child(customer, 'PartyLegalEntity', 'CompanyID'))),
    bankAccount,
    bankAccounts: (bankAccount || '').split(';').map(a => a.trim()).filter(Boolean),
    paymentReference: payId.reference,
    paymentModel: payId.model,
    // A credit note reduces what is owed. Booked positive it is wrong in the
    // P&L and in the payables at once, and it reads as an ordinary bill.
    net: sign(num(child(root, 'LegalMonetaryTotal', 'TaxExclusiveAmount'))),
    vat: sign(pickTaxAmount(root, currency)),
    total: sign(num(child(root, 'LegalMonetaryTotal', 'PayableAmount'))),
    sefPurchaseInvoiceId: text(child(envelope, 'DocumentHeader', 'PurchaseInvoiceId')),
    lines,
  }
}
