// Deleting a posted statement, and everything it created.
//
// Shared by the two screens that list posted statements — the manual entry
// dialog and the bulk import — because the dangerous part of this is the
// SENTENCE, not the delete. It removes transactions, the invoice allocations
// they carried and the credit instalments they closed, which means invoices
// reading `paid` go back to owing money. Nobody should find that out
// afterwards. Two copies of that warning would drift, and the one that
// drifted would be the one somebody read.

export interface DeletionCounts {
  /**
   * The statement's own lines in `transactions` -- NOT counting the principal
   * and interest legs its credit payments posted, which are `creditLegs`.
   */
  transactions: number
  /**
   * The principal and interest rows the statement's credit payments posted
   * beside their bank lines (`type = 'credit_payment'`, `pl_impact` true).
   * They carry the batch since 20261125090000, so the delete takes them too;
   * counted apart so that one credit payment does not read as three lines.
   * Optional so a count built before it existed still reads.
   */
  creditLegs?: number
  /**
   * The statement's credit BANK LINES (`credit_payment`, `pl_impact` not true)
   * that no instalment points to: credit payments posted before 20261125090000,
   * whose legs carry no batch and whose instalment was never stamped. The
   * delete cannot find their legs or their instalments. null when it could not
   * be read; optional so a count built before it existed still reads.
   */
  unlinkedCreditLines?: number | null
  passthroughs: number
  /** Distinct invoices this statement allocated against. */
  invoiceIds: string[]
  /** Those of them that currently read as paid, by invoice number. */
  closing: string[]
}

/**
 * What the owner is asked, before anything is touched.
 *
 * Every figure is named. The invoices that will stop reading as paid are
 * listed, up to eight of them, because "3 invoice allocations" does not tell
 * anybody which of their suppliers is about to be owed money again.
 */
export function deletionWarning(fileName: string | null | undefined, c: DeletionCounts): string {
  const lines = [
    `Obrisati „${fileName || 'ovaj izvod'}“ i sve što je proknjižio?`,
    '',
    `· transakcija: ${c.transactions}`,
  ]
  const legs = c.creditLegs ?? 0
  if (legs > 0) {
    lines.push(`· redova glavnice i kamate iz otplata kredita: ${legs}`)
  }
  if (c.passthroughs > 0) {
    lines.push(`· prolaznih stavki: ${c.passthroughs}`)
  }
  if (c.invoiceIds.length > 0) {
    lines.push(`· raspodela na fakture: ${c.invoiceIds.length}`)
    if (c.closing.length > 0) {
      lines.push('')
      lines.push(`Fakture koje se sada vode kao plaćene i ponovo će imati dug (${c.closing.length}):`)
      lines.push(c.closing.slice(0, 8).join(', ')
        + (c.closing.length > 8 ? ` i još ${c.closing.length - 8}` : ''))
    }
  }
  const unlinked = c.unlinkedCreditLines
  if (unlinked === null) {
    lines.push('')
    lines.push(UNLINKED_UNKNOWN)
  } else if ((unlinked ?? 0) > 0) {
    lines.push('')
    lines.push(`Stavki otplate kredita koje nisu vezane za svoju ratu: ${unlinked}.`)
    lines.push(UNLINKED_WARNING)
  }
  lines.push('')
  lines.push('Ovo se ne može poništiti odavde.')
  return lines.join('\n')
}

/** What an old credit payment leaves behind when its statement is deleted. */
export const UNLINKED_WARNING =
  'Proknjižene su pre nego što je izvod pamtio svoje redove glavnice i kamate, pa ih ovo brisanje '
  + 'NE uklanja i NE vraća njihove rate na neplaćene. Pre nego što isti izvod ponovo uvezete, ručno '
  + 'obrišite te redove glavnice i kamate i vratite rate na neplaćene — inače će otplata biti '
  + 'proknjižena dvaput, a kao plaćena biće označena sledeća rata.'

/** The same, when the check itself could not be read. */
export const UNLINKED_UNKNOWN =
  'Nije bilo moguće proveriti otplate kredita ovog izvoda. Ako ih ima i proknjižene su pre nego što '
  + 'je izvod pamtio svoje redove glavnice i kamate, ovo brisanje te redove NE uklanja i NE vraća '
  + 'njihove rate na neplaćene.'

/**
 * What was actually done, in the same terms the warning used.
 *
 * `transactions_deleted` counts EVERY row of the batch in `transactions`, the
 * credit legs included. Given the counts the warning was built from, the
 * figure is split back into lines and legs so it reads as the warning did.
 */
export function deletionSummary(r: any, counts?: Pick<DeletionCounts, 'creditLegs'>): string {
  const d = (r || {}) as any
  const all = d.transactions_deleted ?? 0
  const legs = Math.min(counts?.creditLegs ?? 0, all)
  return `Obrisano transakcija: ${all - legs}`
    + (legs > 0 ? `, redova glavnice i kamate iz otplata kredita: ${legs}` : '')
    + ((d.passthroughs_deleted ?? 0) > 0 ? `, prolaznih stavki: ${d.passthroughs_deleted}` : '')
    + `, uklonjeno raspodela: ${d.allocations_removed ?? 0}`
    + ((d.installments_reopened ?? 0) > 0 ? `, ponovo otvoreno rata kredita: ${d.installments_reopened}` : '')
    + ((d.credits_reopened ?? 0) > 0 ? `, ponovo otvoreno kredita: ${d.credits_reopened}` : '')
    + ((d.invoices_restated ?? 0) > 0 ? `, faktura kojima se promenio status: ${d.invoices_restated}` : '')
    + '.'
}

/** Count what a batch holds, before asking. Soft-deleted rows are excluded. */
export async function gatherDeletion(supabase: any, batchId: string): Promise<DeletionCounts> {
  const [{ count: txCount }, { count: legCount, error: legErr }, { count: ptCount }, { data: links }] = await Promise.all([
    supabase.from('transactions').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null),
    // The credit legs among them (see `creditLegs`). A failed read counts
    // none apart, which is how the warning read before they carried the batch.
    supabase.from('transactions').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null)
      .eq('type', 'credit_payment').eq('pl_impact', true),
    supabase.from('passthrough').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null),
    supabase.from('invoice_transaction_links')
      .select('invoice_id, transactions!inner(import_batch_id)')
      .eq('transactions.import_batch_id', batchId),
  ])

  const invoiceIds = Array.from(new Set((links || []).map((l: any) => l.invoice_id))) as string[]
  const { data: affected } = invoiceIds.length > 0
    ? await supabase.from('v_invoice_status')
        .select('invoice_number, calculated_status').in('id', invoiceIds)
    : { data: [] as any[] }

  const creditLegs = legErr ? 0 : Math.min(legCount ?? 0, txCount ?? 0)
  return {
    transactions: (txCount ?? 0) - creditLegs,
    creditLegs,
    unlinkedCreditLines: await countUnlinkedCreditLines(supabase, batchId),
    passthroughs: ptCount ?? 0,
    invoiceIds,
    closing: (affected || [])
      .filter((i: any) => i.calculated_status === 'paid')
      .map((i: any) => i.invoice_number || '(bez broja)'),
  }
}

/**
 * The batch's credit bank lines posted before their legs carried the batch
 * (see `unlinkedCreditLines`). null when any read fails.
 *
 * "No instalment points to it" alone is not enough: an instalment paid by two
 * NEW bank lines remembers only the second, so the first would read as old.
 * A line counts only when, besides, the batch holds NO stamped leg
 * (`credit_payment`, `pl_impact` true) on that line's date, bank and partner
 * -- the legs a new line writes beside itself.
 */
async function countUnlinkedCreditLines(supabase: any, batchId: string): Promise<number | null> {
  try {
    const { data: lines, error } = await supabase.from('transactions')
      .select('id, transaction_date, bank_id, partner_id')
      .eq('import_batch_id', batchId).is('deleted_at', null)
      .eq('type', 'credit_payment').not('pl_impact', 'is', true)
    if (error) return null
    const all = (lines || []) as any[]
    if (all.length === 0) return 0
    const { data: paid, error: paidErr } = await supabase.from('credit_installments')
      .select('transaction_id').in('transaction_id', all.map(l => l.id))
    if (paidErr) return null
    const linked = new Set(((paid || []) as any[]).map(i => i.transaction_id))
    const unlinked = all.filter(l => !linked.has(l.id))
    if (unlinked.length === 0) return 0
    const { data: legs, error: legErr } = await supabase.from('transactions')
      .select('transaction_date, bank_id, partner_id')
      .eq('import_batch_id', batchId).is('deleted_at', null)
      .eq('type', 'credit_payment').eq('pl_impact', true)
    if (legErr) return null
    const key = (r: any) => `${r.transaction_date ?? ''}|${r.bank_id ?? ''}|${r.partner_id ?? ''}`
    const stamped = new Set(((legs || []) as any[]).map(key))
    return unlinked.filter(l => !stamped.has(key(l))).length
  } catch {
    return null
  }
}

/**
 * One call, one database transaction: a closed period refuses the whole batch
 * rather than leaving half a statement behind.
 */
export async function deleteStatementBatch(supabase: any, batchId: string): Promise<any> {
  const { data, error } = await supabase.rpc('delete_statement_cascade', {
    p_batch_id: batchId,
    p_deleted_by: null,
  })
  if (error) throw error
  return data
}
