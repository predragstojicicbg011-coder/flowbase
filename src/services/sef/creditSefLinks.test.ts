import { loadCreditSefLinks, linksByInstalment, sefLinkLabel, LINK_COLUMNS } from './creditSefLinks'

// Invented numbers and figures.

const client = (rows: any[] | null, error: any = null) => {
  const calls: any[] = []
  const q: any = {
    select: (c: string) => { calls.push(['select', c]); return q },
    eq: (c: string, v: any) => { calls.push(['eq', c, v]); return q },
    order: (c: string) => { calls.push(['order', c]); return q },
    range: () => Promise.resolve({ data: rows, error }),
  }
  return { client: { from: (t: string) => { calls.push(['from', t]); return q } }, calls }
}

describe('reading the linked SEF invoices', () => {
  it('reads the linked rows of the inbox itself, and only the columns a chip needs', async () => {
    const { client: c, calls } = client([
      { id: 's1', credit_installment_id: 'i-1', document_number: 'KR-1/26', supplier_name: 'Larkspur banka', amount: '30707.57', currency: 'RSD', pdf_path: 'co/1.pdf', linked_at: '2026-11-02T10:00:00Z' },
      { id: 's2', credit_installment_id: null, document_number: 'KR-2/26', supplier_name: null, amount: null, currency: null, pdf_path: null, linked_at: null },
    ])
    const got = await loadCreditSefLinks(c)
    expect(calls).toContainEqual(['from', 'sef_inbox'])
    expect(calls).toContainEqual(['select', LINK_COLUMNS])
    expect(calls).toContainEqual(['eq', 'state', 'linked'])
    expect(LINK_COLUMNS).not.toMatch(/ubl_xml|overview_json/)
    expect(got).toEqual([{
      inboxId: 's1', installmentId: 'i-1', documentNumber: 'KR-1/26', supplierName: 'Larkspur banka',
      amount: 30707.57, currency: 'RSD', pdfPath: 'co/1.pdf', linkedAt: '2026-11-02T10:00:00Z',
    }])
  })

  it('throws when the read fails', async () => {
    const { client: c } = client(null, { message: 'pad veze' })
    await expect(loadCreditSefLinks(c)).rejects.toEqual({ message: 'pad veze' })
  })
})

describe('the links of each instalment', () => {
  it('keeps every invoice of an instalment, in the order read', () => {
    const l = (inboxId: string, installmentId: string) => ({ inboxId, installmentId, documentNumber: null, supplierName: null, amount: null, currency: null, pdfPath: null, linkedAt: null })
    const by = linksByInstalment([l('a', 'i-1'), l('b', 'i-2'), l('c', 'i-1')])
    expect(by.get('i-1')!.map(x => x.inboxId)).toEqual(['a', 'c'])
    expect(by.get('i-2')!.map(x => x.inboxId)).toEqual(['b'])
  })

  it('labels a chip with the number and the amount', () => {
    expect(sefLinkLabel({ documentNumber: 'KR-1/26', amount: 30707.57, currency: 'RSD' })).toBe('SEF KR-1/26 · 30.707,57 RSD')
    expect(sefLinkLabel({ documentNumber: null, amount: null, currency: null })).toBe('SEF faktura · —')
  })
})
