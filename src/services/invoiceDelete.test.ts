import { deleteConsequences, deleteInvoiceCascade, previewDelete, type DeletePreview } from './invoiceDelete'

const empty: DeletePreview = {
  invoice_number: 'IF-1/2026', payments_unlinked: 0, advance_links_removed: 0,
  finals_reopened: [], notes_deleted: [], debit_notes_deleted: [], uploads_removed: 0, sef_row: null,
}

describe('deleteConsequences', () => {
  it('lists every consequence of a full preview', () => {
    expect(deleteConsequences({
      ...empty, payments_unlinked: 2, advance_links_removed: 1, finals_reopened: ['IF-9/2026'],
      notes_deleted: ['KO-1/2026'], uploads_removed: 1, sef_row: 'pending',
    })).toEqual([
      'Veze sa 2 uplate se raskidaju; uplate ostaju na izvodu, nepovezane.',
      'Veze sa avansima se brišu (1).',
      'Konačna faktura IF-9/2026 ponovo potražuje deo koji je pokrivao ovaj avans.',
      'Briše se i knjižno odobrenje KO-1/2026.',
      'Ručno otpremljeni PDF-ovi se sklanjaju (1).',
      'SEF red se vraća u red „čeka“.',
    ])
  })

  it('names a debit note a debit note', () => {
    expect(deleteConsequences({ ...empty, notes_deleted: ['KO-1', 'KZ-1'], debit_notes_deleted: ['KZ-1'] })).toEqual([
      'Briše se i knjižno odobrenje KO-1.',
      'Briše se i knjižno zaduženje KZ-1.',
    ])
  })

  it('says a cancelled SEF row stays declined', () => {
    expect(deleteConsequences({ ...empty, sef_row: 'dismissed' }))
      .toEqual(['SEF red ostaje odbijen (faktura je stornirana na SEF-u).'])
  })

  it('has one sentence for an invoice with nothing linked', () => {
    expect(deleteConsequences(empty)).toEqual(['Faktura nema vezanih uplata, avansa ni dokumenata.'])
  })

  it('declines the payments sentence by count', () => {
    expect(deleteConsequences({ ...empty, payments_unlinked: 1 })[0]).toMatch(/^Veza sa 1 uplatom/)
    expect(deleteConsequences({ ...empty, payments_unlinked: 5 })[0]).toMatch(/^Veze sa 5 uplata /)
    expect(deleteConsequences({ ...empty, payments_unlinked: 12 })[0]).toMatch(/^Veze sa 12 uplata /)
  })
})

describe('the database calls', () => {
  it('previews with a dry run', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { ...empty, payments_unlinked: 1 }, error: null })
    const p = await previewDelete({ rpc }, 'inv1')
    expect(rpc).toHaveBeenCalledWith('delete_invoice_cascade', { p_invoice: 'inv1', p_dry_run: true })
    expect(p.payments_unlinked).toBe(1)
    expect(p.debit_notes_deleted).toEqual([])
  })

  it('deletes with a real call', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: empty, error: null })
    await deleteInvoiceCascade({ rpc }, 'inv1')
    expect(rpc).toHaveBeenCalledWith('delete_invoice_cascade', { p_invoice: 'inv1', p_dry_run: false })
  })

  it('throws the database message', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'Period je zaključan' } })
    await expect(deleteInvoiceCascade({ rpc }, 'inv1')).rejects.toThrow('Period je zaključan')
  })
})
