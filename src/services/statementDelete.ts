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
  transactions: number
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
  lines.push('')
  lines.push('Ovo se ne može poništiti odavde.')
  return lines.join('\n')
}

/** What was actually done, in the same terms the warning used. */
export function deletionSummary(r: any): string {
  const d = (r || {}) as any
  return `Obrisano transakcija: ${d.transactions_deleted ?? 0}`
    + ((d.passthroughs_deleted ?? 0) > 0 ? `, prolaznih stavki: ${d.passthroughs_deleted}` : '')
    + `, uklonjeno raspodela: ${d.allocations_removed ?? 0}`
    + ((d.installments_reopened ?? 0) > 0 ? `, ponovo otvoreno rata kredita: ${d.installments_reopened}` : '')
    + ((d.invoices_restated ?? 0) > 0 ? `, faktura kojima se promenio status: ${d.invoices_restated}` : '')
    + '.'
}

/** Count what a batch holds, before asking. Soft-deleted rows are excluded. */
export async function gatherDeletion(supabase: any, batchId: string): Promise<DeletionCounts> {
  const [{ count: txCount }, { count: ptCount }, { data: links }] = await Promise.all([
    supabase.from('transactions').select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).is('deleted_at', null),
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

  return {
    transactions: txCount ?? 0,
    passthroughs: ptCount ?? 0,
    invoiceIds,
    closing: (affected || [])
      .filter((i: any) => i.calculated_status === 'paid')
      .map((i: any) => i.invoice_number || '(bez broja)'),
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
