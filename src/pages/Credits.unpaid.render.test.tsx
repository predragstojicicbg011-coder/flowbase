import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CreditRow } from './Credits'
import RevolvingCredits from '../components/RevolvingCredits'

// "Vrati na neplaćeno" on an instalment, and the SEF interest invoices linked
// to instalments, on the Krediti page. Invented credit, numbers and figures.

jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: (global as any).__canEdit }) }))

jest.mock('../supabase', () => {
  const rpcCalls: any[] = []
  const writes: any[] = []
  const chain: any = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is']) chain[m] = () => chain
  chain.update = (p: any) => { writes.push(['update', p]); return chain }
  chain.insert = (p: any) => { writes.push(['insert', p]); return chain }
  chain.delete = () => { writes.push(['delete']); return chain }
  chain.then = (f: any, r: any) => Promise.resolve({ data: [], error: null }).then(f, r)
  return {
    supabase: {
      from: (t: string) => { writes.push(['from', t]); return chain },
      rpc: (fn: string, args: any) => {
        rpcCalls.push({ fn, args })
        const answer = (global as any).__rpcAnswer
        return Promise.resolve(answer)
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/kr.pdf' }, error: null }) }) },
    },
    __rpc: rpcCalls,
    __writes: writes,
  }
})

const mock = () => jest.requireMock('../supabase') as any
const unpaidCalls = () => (mock().__rpc as any[]).filter(c => c.fn === 'credit_installment_mark_unpaid')

const credit: any = {
  id: 'cr-1', company_id: 'co-1', name: 'Obrtni kredit', bank: 'Larkspur banka', principal_amount: 30000, currency: 'EUR',
  interest_rate: 5, rate_type: 'fixed', rate_description: '5% fiksno', disbursement_date: '2026-01-01',
  first_payment_date: '2026-02-28', last_payment_date: '2028-01-31', monthly_annuity: 1262, total_installments: 24,
  status: 'closed', notes: null, kind: 'annuity',
}
const inst = (over: Record<string, unknown>): any => ({
  id: 'i-1', credit_id: 'cr-1', installment_no: 1, due_date: '2026-10-31', principal_amount: 1000, interest_amount: 250,
  total_amount: 1250, status: 'paid', transaction_id: 'tx-1', paid_date: '2026-10-30', paid_amount: 1250, notes: null, ...over,
})
const installments = [
  inst({}),
  inst({ id: 'i-2', installment_no: 2, due_date: '2026-11-30', status: 'outstanding', paid_amount: 600, paid_date: null, transaction_id: null }),
  inst({ id: 'i-3', installment_no: 3, due_date: '2026-12-31', status: 'outstanding', paid_amount: 0, paid_date: null, transaction_id: null }),
]
const link = (inboxId: string, installmentId: string, pdfPath: string | null = 'co-1/9000.pdf') => ({
  inboxId, installmentId, documentNumber: `KR-${inboxId}/26`, supplierName: 'Larkspur banka',
  amount: 30707.57, currency: 'RSD', pdfPath, linkedAt: '2026-11-02T10:00:00Z',
})

let refreshed = 0
const show = (sefLinks?: Map<string, any[]>) => {
  const r = render(<CreditRow credit={credit} installments={installments} sefLinks={sefLinks}
    onRefresh={() => { refreshed += 1 }} onEdit={() => {}} />)
  fireEvent.click(screen.getByText('Obrtni kredit'))
  fireEvent.click(screen.getByText('Sve'))
  return r
}
const rowOf = (c: HTMLElement, id: string) => c.querySelector(`[data-inst="${id}"]`) as HTMLElement

beforeEach(() => {
  ;(global as any).__canEdit = true
  ;(global as any).__rpcAnswer = { data: { credit_reopened: true, sef_links: 1 }, error: null }
  mock().__rpc.length = 0
  mock().__writes.length = 0
  refreshed = 0
})
afterEach(() => jest.restoreAllMocks())

describe('Vrati na neplaćeno', () => {
  it('is offered on a paid and a partly paid instalment, never on an unpaid one', () => {
    const { container } = show()
    expect(within(rowOf(container, 'i-1')).getByText('Vrati na neplaćeno')).toBeTruthy()
    expect(within(rowOf(container, 'i-2')).getByText('Vrati na neplaćeno')).toBeTruthy()
    expect(within(rowOf(container, 'i-3')).queryByText('Vrati na neplaćeno')).toBeNull()
  })

  it('is not offered to someone who may not edit an instalment', () => {
    ;(global as any).__canEdit = false
    const { container } = show()
    expect(within(rowOf(container, 'i-1')).queryByText('Vrati na neplaćeno')).toBeNull()
  })

  it('asks first, saying what moves, that the credit reopens, the SEF link stays and the posted rows stay', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = show(new Map([['i-1', [link('s1', 'i-1')]]]))
    fireEvent.click(within(rowOf(container, 'i-1')).getByText('Vrati na neplaćeno'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe([
      'Vratiti ratu #1 (dospeće 31.10.2026.) kredita „Obrtni kredit“ na neplaćenu?',
      '',
      '· rata postaje neplaćena: plaćeno 0, bez datuma plaćanja i bez veze sa stavkom izvoda (sada plaćeno 1.250,00 EUR od 1.250,00 EUR)',
      '· kredit je zatvoren, pa se ponovo otvara',
      '· SEF faktura kamate vezana za ovu ratu ostaje vezana',
      '',
      'Redovi glavnice i kamate koji su za ovu ratu već proknjiženi OSTAJU u P&L-u: ovo ih ne briše. '
        + 'Ako su pogrešni, obrišite ih posebno na strani Transakcije — inače će otplata, kada se rata ponovo plati, '
        + 'biti proknjižena dvaput.',
    ].join('\n'))
    // Declined: nothing written.
    expect(unpaidCalls()).toEqual([])
    expect(mock().__writes.filter((w: any[]) => w[0] !== 'from')).toEqual([])
  })

  it('writes through the one function only, never a table and never a transaction, then reloads', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = show()
    fireEvent.click(within(rowOf(container, 'i-2')).getByText('Vrati na neplaćeno'))
    await waitFor(() => expect(unpaidCalls()).toHaveLength(1))
    expect(unpaidCalls()[0].args).toEqual({ p_id: 'i-2' })
    expect(mock().__writes).toEqual([])
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Rata #2 je vraćena na neplaćenu. Kredit je ponovo otvoren. SEF faktura kamate ostaje vezana za nju. Redovi glavnice i kamate u P&L-u nisu dirani.')
    expect(refreshed).toBe(1)
  })

  it('shows the refusal as the database said it, and reloads nothing', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true)
    ;(global as any).__rpcAnswer = { data: null, error: { message: 'Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.' } }
    const { container } = show()
    fireEvent.click(within(rowOf(container, 'i-1')).getByText('Vrati na neplaćeno'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rata nije vraćena na neplaćenu: Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.')
    expect(refreshed).toBe(0)
  })
})

describe('the SEF interest invoices on an instalment', () => {
  it('shows every invoice linked to an instalment under it, and none elsewhere', () => {
    const { container } = show(new Map([['i-1', [link('s1', 'i-1'), link('s2', 'i-1', null)]]]))
    const chips = container.querySelector('[data-sef-links="i-1"]') as HTMLElement
    expect(within(chips).getByText('SEF KR-s1/26 · 30.707,57 RSD')).toBeTruthy()
    expect(within(chips).getByText('SEF KR-s2/26 · 30.707,57 RSD (PDF nije sačuvan)')).toBeTruthy()
    expect(container.querySelector('[data-sef-links="i-2"]')).toBeNull()
  })

  it('opens the kept PDF from storage, never SEF', async () => {
    const tab: any = { opener: 'x', location: { href: '' }, close: jest.fn() }
    jest.spyOn(window, 'open').mockReturnValue(tab)
    const { container } = show(new Map([['i-1', [link('s1', 'i-1')]]]))
    fireEvent.click(within(container.querySelector('[data-sef-links="i-1"]') as HTMLElement).getByText('SEF KR-s1/26 · 30.707,57 RSD'))
    await waitFor(() => expect(tab.location.href).toBe('https://signed.example/kr.pdf'))
  })

  it('lists a revolving tranche\'s linked invoices with their instalment', () => {
    render(<RevolvingCredits
      credits={[{ ...credit, id: 'rv-1', name: 'Revolving linija', kind: 'revolving', status: 'active', maturity_date: '2027-02-11', rate_margin: 3 } as any]}
      sefLinks={[{ link: link('s9', 'ri-4'), creditId: 'rv-1', installmentNo: 4, dueDate: '2026-11-11' }]}
      onRefresh={() => {}} />)
    fireEvent.click(screen.getByText('Revolving linija'))
    expect(screen.getByText('SEF fakture kamate')).toBeTruthy()
    expect(screen.getByText(/^#4 · dospeva /)).toBeTruthy()
    expect(screen.getByText('SEF KR-s9/26 · 30.707,57 RSD')).toBeTruthy()
  })
})
