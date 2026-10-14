// A bill may already be in the ledger: invoices have been typed in by hand for
// a year, and SEF does not know that.
//
// This WARNS. It does not refuse. It may be a genuine duplicate, and it may be
// a supplier reusing a number across years — the first is the owner's call and
// the second is not an assumption to make for him.

export interface LedgerInvoice {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  amount: number | null
  currency: string | null
  partner_id: string | null
}

export interface DuplicateWarning { invoice: LedgerInvoice; text: string }

/** Numbers are compared on their alphanumerics: `2026/0412` and `2026-0412`
 *  from one supplier are one bill. */
const foldNumber = (n: string | null | undefined): string =>
  (n || '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function findLikelyDuplicate(
  row: { document_number: string | null; amount: number | null; currency: string | null; partner_id: string | null },
  ledger: LedgerInvoice[],
): DuplicateWarning | null {
  const want = foldNumber(row.document_number)
  // Both halves are required. An invoice number is unique per SUPPLIER, not
  // across the country — `1` and `2026-01` are numbers everybody uses, and a
  // warning that fires on strangers is one that gets ignored by habit.
  if (!want || !row.partner_id) return null

  const hit = ledger.find(i =>
    i.partner_id === row.partner_id && foldNumber(i.invoice_number) === want)
  if (!hit) return null

  const money = (n: number | null, currency: string | null) => {
    const figure = n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return currency ? `${figure} ${currency}` : figure
  }

  // 1,000 EUR and 1,000 RSD are not the same bill. A figure that matches in a
  // different currency, or in a currency one side does not state, is the weaker
  // warning: the strong wording is reserved for what is known to agree.
  const same = hit.amount !== null && row.amount !== null
    && Math.abs(hit.amount - row.amount) < 0.01
    && !!hit.currency && hit.currency === row.currency

  return {
    invoice: hit,
    text: same
      ? `Looks like you already have this — invoice ${hit.invoice_number} of ${hit.invoice_date || 'an unknown date'}.`
      : `You already have invoice ${hit.invoice_number} of ${hit.invoice_date || 'an unknown date'} from this supplier, for ${money(hit.amount, hit.currency)}; this one is ${money(row.amount, row.currency)}.`,
  }
}
