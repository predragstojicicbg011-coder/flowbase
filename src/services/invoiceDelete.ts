// Deleting an invoice together with everything linked to it, in one database
// call (delete_invoice_cascade). The same function answers a dry run, which is
// what the confirmation lists before anything is deleted.

export interface DeletePreview {
  invoice_number: string | null
  payments_unlinked: number
  advance_links_removed: number
  finals_reopened: string[]
  notes_deleted: string[]
  uploads_removed: number
  sef_row: 'pending' | 'dismissed' | null
}

/** "2 uplate", "5 uplata", "1 uplatom" is not needed: the sentence is built per count. */
function paymentsSentence(n: number): string {
  const last = n % 10
  const teen = n % 100 >= 11 && n % 100 <= 14
  if (last === 1 && !teen) return `Veza sa ${n} uplatom se raskida; uplata ostaje na izvodu, nepovezana.`
  const word = last >= 2 && last <= 4 && !teen ? 'uplate' : 'uplata'
  return `Veze sa ${n} ${word} se raskidaju; uplate ostaju na izvodu, nepovezane.`
}

/** What deleting will do, one sentence each, for the confirmation. */
export function deleteConsequences(p: DeletePreview): string[] {
  const out: string[] = []
  if (p.payments_unlinked > 0) out.push(paymentsSentence(p.payments_unlinked))
  if (p.advance_links_removed > 0) out.push(`Veze sa avansima se brišu (${p.advance_links_removed}).`)
  for (const n of p.finals_reopened) out.push(`Konačna faktura ${n} ponovo potražuje deo koji je pokrivao ovaj avans.`)
  for (const n of p.notes_deleted) out.push(`Briše se i knjižno odobrenje ${n}.`)
  if (p.uploads_removed > 0) out.push(`Ručno otpremljeni PDF-ovi se sklanjaju (${p.uploads_removed}).`)
  if (p.sef_row === 'pending') out.push('SEF red se vraća u red „čeka“.')
  if (p.sef_row === 'dismissed') out.push('SEF red ostaje odbijen (faktura je stornirana na SEF-u).')
  if (out.length === 0) out.push('Faktura nema vezanih uplata, avansa ni dokumenata.')
  return out
}

async function call(client: { rpc: Function }, invoiceId: string, dry: boolean): Promise<DeletePreview> {
  const { data, error } = await client.rpc('delete_invoice_cascade', { p_invoice: invoiceId, p_dry_run: dry })
  if (error) throw new Error(error.message || 'Brisanje nije uspelo.')
  const d = (data || {}) as Partial<DeletePreview>
  return {
    invoice_number: d.invoice_number ?? null,
    payments_unlinked: d.payments_unlinked ?? 0,
    advance_links_removed: d.advance_links_removed ?? 0,
    finals_reopened: d.finals_reopened ?? [],
    notes_deleted: d.notes_deleted ?? [],
    uploads_removed: d.uploads_removed ?? 0,
    sef_row: d.sef_row ?? null,
  }
}

export const previewDelete = (client: { rpc: Function }, invoiceId: string) => call(client, invoiceId, true)
export const deleteInvoiceCascade = (client: { rpc: Function }, invoiceId: string) => call(client, invoiceId, false)
