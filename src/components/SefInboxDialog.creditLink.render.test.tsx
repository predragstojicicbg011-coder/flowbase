import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import SefInboxDialog from './SefInboxDialog'

// A bank's interest invoice, linked to its credit instalment instead of booked.
// Invented bank, PIBs, credits, rates and figures throughout.

jest.mock('./InvoiceDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('./PartnerDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ canEdit: (global as any).__db.canEdit }) }))

// The NBS rates of a day, as FlowBase reads them. Counted, so a test can say
// that a same-currency invoice asks for none.
jest.mock('../services/bookAmounts', () => {
  const actual = jest.requireActual('../services/bookAmounts')
  return {
    ...actual,
    // A plain function, not jest.fn: the CRA preset resets mocks before each test.
    getBookRates: async (date: string) => {
      const db = (global as any).__db
      db.ratesAsked.push(date)
      if (db.rateFails) throw new Error(`Kurs NBS nije dostupan za ${date}`)
      return { date, eurRate: 117.2, usdRate: 108.5, source: 'test' }
    },
  }
})

jest.mock('../supabase', () => {
  const updates: any[] = []
  const rpcCalls: any[] = []
  const invoke = jest.fn()
  const db = () => (global as any).__db
  const table = (name: string, eqs: [string, any][] = [], patch: any = null, entry: any = null): any => ({
    select: () => table(name, eqs, patch, entry),
    eq: (c: string, v: any) => {
      const next: [string, any][] = [...eqs, [c, v]]
      if (entry) entry.eqs = next
      return table(name, next, patch, entry)
    },
    is: () => table(name, eqs, patch, entry),
    in: () => table(name, eqs, patch, entry),
    order: () => table(name, eqs, patch, entry),
    limit: () => table(name, eqs, patch, entry),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    range: () => Promise.resolve(db().failing === name
      ? { data: null, error: { message: 'pad veze' } }
      : { data: (db()[name] ?? []).filter((row: any) => eqs.every(([c, v]) => row[c] === undefined || row[c] === v)), error: null }),
    update: (p: any) => {
      const e = { name, patch: p, eqs: [] as [string, any][] }
      updates.push(e)
      return table(name, eqs, p, e)
    },
    then: (f: any, r: any) => {
      if (patch) return Promise.resolve({ data: [{ id: 'x' }], error: null }).then(f, r)
      const data = (db()[name] ?? []).filter((row: any) => eqs.every(([c, v]) => row[c] === v))
      return Promise.resolve({ data, error: null }).then(f, r)
    },
  })
  const rpc = (fn: string, args: any) => {
    rpcCalls.push({ fn, args })
    if (fn === 'sef_inbox_link_installment') {
      const failure = db().linkError
      return Promise.resolve(failure ? { data: null, error: { message: failure } } : { data: null, error: null })
    }
    return Promise.resolve({ data: [{ date_from: '2026-08-01', date_to: '2026-11-24' }], error: null })
  }
  return { supabase: { from: (n: string) => table(n), rpc, functions: { invoke } }, __updates: updates, __rpc: rpcCalls, __invoke: invoke }
})

const mock = () => jest.requireMock('../supabase') as any
const updates = () => mock().__updates as any[]
const links = () => (mock().__rpc as any[]).filter(c => c.fn === 'sef_inbox_link_installment')

const BANK_PIB = '900000017'
const recent = () => new Date(Date.now() - 20 * 60 * 1000).toISOString()

const base = {
  sef_decision: null, sef_decision_comment: null, sef_decided_at: null, sef_decided_by_name: null,
  dismiss_reason: null, dismissed_at: null, imported_at: null, pdf_kind: null, pdf_note: null,
  supplier_registration_number: null, document_type: 'Invoice', direction: 'purchase',
}
const pending = {
  ...base, id: 'p1', company_id: 'co-1', sef_invoice_id: 9001, document_number: 'KR-0101/26',
  supplier_name: 'Larkspur banka', supplier_vat_number: BANK_PIB,
  amount: 262.01, currency: 'EUR', delivery_date: null, due_date: '2026-11-30', sent_date: '2026-11-28T09:00:00Z',
  sef_status: 'New', state: 'pending', ubl_fetched_at: null, pdf_path: null,
  credit_installment_id: null, linked_at: null,
}
const linked = {
  ...pending, id: 'l1', sef_invoice_id: 9000, document_number: 'KR-0100/26', amount: 258, due_date: '2026-10-31',
  sent_date: '2026-10-29T09:00:00Z', state: 'linked', credit_installment_id: 'i-1', linked_at: '2026-11-02T10:00:00Z',
}
const otherSupplier = {
  ...pending, id: 'q1', sef_invoice_id: 9002, document_number: 'Q-77', supplier_name: 'Kancelarija Kamenolom',
  supplier_vat_number: '900000555', amount: 99, currency: 'USD',
}
// The same interest, billed in dinars: 262,01 EUR at 117,2 RSD.
const inDinars = { ...pending, id: 'd1', sef_invoice_id: 9003, document_number: 'KR-0102/26', amount: 30707.57, currency: 'RSD' }

const credits = (lenderPib: string | null = null) => [
  { id: 'cr-1', company_id: 'co-1', name: 'Obrtni kredit', bank: 'Larkspur banka', currency: 'EUR', status: 'active', kind: 'annuity', lender_pib: lenderPib },
  { id: 'cr-2', company_id: 'co-1', name: 'Stari kredit za opremu', bank: 'Larkspur banka', currency: 'EUR', status: 'closed', kind: 'annuity', lender_pib: null },
]
const installments = [
  { id: 'i-1', credit_id: 'cr-1', installment_no: 1, due_date: '2026-10-31', interest_amount: 250, status: 'paid', paid_amount: 1250 },
  { id: 'i-2', credit_id: 'cr-1', installment_no: 2, due_date: '2026-11-30', interest_amount: 262.01, status: 'outstanding', paid_amount: 0 },
  { id: 'i-3', credit_id: 'cr-2', installment_no: 9, due_date: '2026-11-30', interest_amount: 262.01, status: 'paid', paid_amount: 900 },
]

beforeEach(() => {
  ;(global as any).__db = {
    sef_inbox: [pending, linked, otherSupplier],
    credits: credits(),
    credit_installments: installments,
    // The bank is a partner with a booked bill, so a classification proposal exists.
    partners: [{ id: 'pt-bank', name: 'Larkspur banka', tax_id: BANK_PIB, registration_number: null }],
    invoices: [{ id: 'inv-old', invoice_number: 'KR-0001/26', invoice_date: '2026-01-31', amount: 100, currency: 'EUR', partner_id: 'pt-bank',
      pl_category: 'Bankarske usluge', pl_subcategory: 'Provizije banke', department: null, cf_type: null }],
    quick_fill_scripts: [],
    processor_sync_runs: [{ provider: 'sef', status: 'complete', finished_at: recent(), started_at: recent(), error: null }],
    failing: null,
    linkError: null,
    canEdit: true,
    ratesAsked: [] as string[],
    rateFails: false,
  }
  updates().length = 0
  mock().__rpc.length = 0
  mock().__invoke.mockReset()
})

const show = () => render(<SefInboxDialog onClose={() => {}} onImported={() => {}} />)
const rowOf = (name: string) => screen.getByText(name).closest('[data-row]') as HTMLElement
const rowById = (c: HTMLElement, id: string) => c.querySelector(`[data-row="${id}"]`) as HTMLElement
const chip = (label: RegExp) => screen.getAllByRole('button').find(b => label.test(b.textContent || '')) as HTMLElement
const options = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-option]')).map(o => o.getAttribute('data-option'))
const LINK = 'Poveži sa ratom kredita'
const DO_LINK = 'Poveži sa ovom ratom'

describe('the Vezane za kredite tab', () => {
  it('counts the linked invoices beside the others', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    expect(chip(/^Vezane za kredite/).textContent).toBe('Vezane za kredite1')
  })

  it('shows what each invoice is linked to, the difference, and Odveži', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(chip(/^Vezane za kredite/))
    const row = rowOf('Larkspur banka')
    expect(within(row).getByText('Povezana sa kreditom „Obrtni kredit“ · rata #1 · dospeva 31. okt 2026. · kamata 250,00 EUR. Nije proknjižena: kamata je u knjigama sa otplatom rate.')).toBeTruthy()
    expect(within(row).getByText('Iznosi se razlikuju: faktura 258,00 EUR, kamata rate 250,00 EUR, razlika 8,00 EUR.')).toBeTruthy()
    expect(within(row).getByText('Odveži').getAttribute('title')).toBe('Vraća fakturu u red; u knjigama se ništa ne menja')
    expect(within(row).queryByText(LINK)).toBeNull()
    expect(within(row).queryByText('Vrati u red')).toBeNull()
  })

  it('unlinks by putting the row back in the queue, and writes only a decision column', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(chip(/^Vezane za kredite/))
    fireEvent.click(within(rowOf('Larkspur banka')).getByText('Odveži'))
    await waitFor(() => expect(updates()).toHaveLength(1))
    expect(updates()[0].name).toBe('sef_inbox')
    expect(updates()[0].patch.state).toBe('pending')
    expect(updates()[0].eqs).toEqual([['id', 'l1']])
    const allowed = ['state', 'dismiss_reason', 'dismissed_at', 'restored_at']
    expect(Object.keys(updates()[0].patch).filter(k => !allowed.includes(k))).toEqual([])
  })

  it('still offers the decision on SEF for a linked invoice that was opened', async () => {
    ;(global as any).__db.sef_inbox = [{ ...linked, ubl_fetched_at: '2026-11-01T08:00:00Z' }]
    show()
    await screen.findByText(/Ništa ne čeka/)
    fireEvent.click(chip(/^Vezane za kredite/))
    const row = rowOf('Larkspur banka')
    expect(within(row).getByText('Prihvati na SEF-u')).toBeTruthy()
    expect(within(row).getByText('Odbij na SEF-u')).toBeTruthy()
  })

  it('says when nothing is linked', async () => {
    ;(global as any).__db.sef_inbox = [pending]
    show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(chip(/^Vezane za kredite/))
    expect(screen.getByText('Nijedna faktura još nije povezana sa ratom kredita.')).toBeTruthy()
  })
})

describe('linking a waiting invoice', () => {
  it('offers the link on waiting rows, to the people who keep the books', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    const button = within(rowOf('Larkspur banka')).getByText(LINK)
    expect(button.getAttribute('title'))
      .toBe('Za kamatu banke koja je već proknjižena sa otplatom rate: povezuje fakturu sa ratom i ništa ne knjiži')
  })

  it('does not offer it to someone who does not keep the books', async () => {
    ;(global as any).__db.canEdit = false
    show()
    await screen.findByText('Kancelarija Kamenolom')
    expect(within(rowOf('Larkspur banka')).queryByText(LINK)).toBeNull()
  })

  it('lists the instalments, the matching one first and proposed', async () => {
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    expect(screen.getByText('Za koju ratu kredita je ova kamata?')).toBeTruthy()
    expect(screen.getByText('Povezivanje ne pravi fakturu i ne menja P&L: kamata se knjiži kada se rata plati. SEF se ne dira.')).toBeTruthy()
    expect(options(container)).toEqual(['i-2', 'i-1'])
    const first = container.querySelector('[data-option="i-2"]') as HTMLElement
    expect(within(first).getByText('Predlog')).toBeTruthy()
    expect(within(first).getByText('Obrtni kredit')).toBeTruthy()
    expect(within(first).getByText('Larkspur banka')).toBeTruthy()
    expect(within(first).getByText('#2')).toBeTruthy()
    expect(within(first).getByText('30. nov 2026.')).toBeTruthy()
    expect(within(first).getByText('262,01 EUR')).toBeTruthy()
    expect(within(first).getByText('Neplaćena')).toBeTruthy()
    expect(within(container.querySelector('[data-option="i-1"]') as HTMLElement).getByText('Plaćena')).toBeTruthy()
    expect((within(first).getByRole('radio') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('faktura 262,01 EUR, kamata rate 262,01 EUR, bez razlike')).toBeTruthy()
  })

  it('shows closed credits only when asked', async () => {
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    expect(options(container)).not.toContain('i-3')
    fireEvent.click(screen.getByLabelText('Prikaži i zatvorene kredite'))
    expect(options(container)).toContain('i-3')
  })

  it('links through the function alone: no invoice, no update, no SEF call, no rate for one currency', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    fireEvent.click(screen.getByText(DO_LINK))
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(links()[0].args).toEqual({ p_id: 'p1', p_installment_id: 'i-2' })
    expect(updates()).toEqual([])
    expect(mock().__invoke).not.toHaveBeenCalled()
    expect((global as any).__db.ratesAsked).toEqual([])
    expect(await screen.findByText('Faktura KR-0101/26 je povezana sa ratom #2 kredita „Obrtni kredit“. Ništa nije proknjiženo.')).toBeTruthy()
  })

  it('asks again before linking an instalment whose interest differs, and says by how much', async () => {
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    fireEvent.click(within(container.querySelector('[data-option="i-1"]') as HTMLElement).getByRole('radio'))
    expect(screen.getByText('faktura 262,01 EUR, kamata rate 250,00 EUR, razlika 12,01 EUR')).toBeTruthy()
    fireEvent.click(screen.getByText(DO_LINK))
    expect(links()).toEqual([])
    expect(screen.getByText('Iznosi se razlikuju: faktura 262,01 EUR, kamata rate 250,00 EUR, razlika 12,01 EUR. Ipak povezati?')).toBeTruthy()
    fireEvent.click(screen.getByText('Poveži uz razliku'))
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(links()[0].args).toEqual({ p_id: 'p1', p_installment_id: 'i-1' })
    expect(await screen.findByText('Faktura KR-0101/26 je povezana sa ratom #1 kredita „Obrtni kredit“. Ništa nije proknjiženo. Iznosi se razlikuju: faktura 262,01 EUR, kamata rate 250,00 EUR, razlika 12,01 EUR.')).toBeTruthy()
  })

  it('withdraws the question when another instalment is chosen', async () => {
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    fireEvent.click(within(container.querySelector('[data-option="i-1"]') as HTMLElement).getByRole('radio'))
    fireEvent.click(screen.getByText(DO_LINK))
    fireEvent.click(within(container.querySelector('[data-option="i-2"]') as HTMLElement).getByRole('radio'))
    expect(screen.queryByText(/Ipak povezati\?/)).toBeNull()
    fireEvent.click(screen.getByText(DO_LINK))
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(links()[0].args.p_installment_id).toBe('i-2')
  })

  it('asks again when the invoice names no amount', async () => {
    ;(global as any).__db.sef_inbox = [{ ...pending, amount: null }]
    const { container } = show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(screen.getByText(LINK))
    fireEvent.click(within(container.querySelector('[data-option="i-2"]') as HTMLElement).getByRole('radio'))
    fireEvent.click(screen.getByText(DO_LINK))
    expect(links()).toEqual([])
    expect(screen.getByText('Faktura ne navodi iznos koji bi se uporedio sa kamatom rate. Ipak povezati?')).toBeTruthy()
  })

  it('chooses nothing by itself when nothing matches and no PIB is remembered', async () => {
    ;(global as any).__db.sef_inbox = [{ ...pending, amount: 263 }]
    const { container } = show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(screen.getByText(LINK))
    expect(Array.from(container.querySelectorAll('input[type="radio"]')).some(r => (r as HTMLInputElement).checked)).toBe(false)
    expect((screen.getByText(DO_LINK) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Predlog')).toBeNull()
  })

  it('shows the refusal on the row, as the function said it', async () => {
    ;(global as any).__db.linkError = 'Faktura ne čeka u redu: već je proknjižena, odbijena ili povezana. Ništa nije povezano.'
    show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    fireEvent.click(screen.getByText(DO_LINK))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Faktura ne čeka u redu: već je proknjižena, odbijena ili povezana. Ništa nije povezano.')
  })

  it('cancels without writing', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    fireEvent.click(screen.getByText('Otkaži'))
    expect(screen.queryByText('Za koju ratu kredita je ova kamata?')).toBeNull()
    expect(links()).toEqual([])
  })

  it('shows the first eight instalments and the rest on request', async () => {
    ;(global as any).__db.credit_installments = Array.from({ length: 10 }, (_, n) => ({
      id: `m-${n}`, credit_id: 'cr-1', installment_no: n + 1, due_date: `2026-${String(n + 1).padStart(2, '0')}-28`,
      interest_amount: 100 + n, status: 'outstanding', paid_amount: 0,
    }))
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    fireEvent.click(within(rowOf('Larkspur banka')).getByText(LINK))
    expect(options(container)).toHaveLength(8)
    fireEvent.click(screen.getByText('Prikaži sve (10)'))
    expect(options(container)).toHaveLength(10)
  })
})

describe('an invoice in dinars for a credit in euros', () => {
  beforeEach(() => { ;(global as any).__db.sef_inbox = [inDinars] })

  it('converts at the NBS middle rate of the invoice day, proposes the match and says the rate', async () => {
    const { container } = show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(screen.getByText(LINK))
    await waitFor(() => expect(within(container.querySelector('[data-option="i-2"]') as HTMLElement).queryByText('Predlog')).toBeTruthy())
    expect((global as any).__db.ratesAsked).toEqual(['2026-11-28'])
    expect(options(container)[0]).toBe('i-2')
    expect(screen.getByText('faktura 30.707,57 RSD ≈ 262,01 EUR po srednjem kursu NBS za 28.11.2026. (1 EUR = 117,2000 RSD), kamata rate 262,01 EUR, bez razlike')).toBeTruthy()
    fireEvent.click(screen.getByText(DO_LINK))
    await waitFor(() => expect(links()).toHaveLength(1))
    expect(links()[0].args).toEqual({ p_id: 'd1', p_installment_id: 'i-2' })
  })

  it('states the converted difference of another instalment', async () => {
    const { container } = show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(screen.getByText(LINK))
    await waitFor(() => expect(screen.queryByText(/po srednjem kursu NBS/)).toBeTruthy())
    fireEvent.click(within(container.querySelector('[data-option="i-1"]') as HTMLElement).getByRole('radio'))
    expect(screen.getByText('faktura 30.707,57 RSD ≈ 262,01 EUR po srednjem kursu NBS za 28.11.2026. (1 EUR = 117,2000 RSD), kamata rate 250,00 EUR, razlika 12,01 EUR')).toBeTruthy()
  })

  it('without a rate, lists by date, chooses nothing, and asks before linking', async () => {
    ;(global as any).__db.rateFails = true
    const { container } = show()
    await screen.findByText('Larkspur banka')
    fireEvent.click(screen.getByText(LINK))
    expect(await screen.findByText('Kurs NBS za 28.11.2026. nije dostupan, pa su rate u drugoj valuti poređane samo po datumu. Kurs NBS nije dostupan za 2026-11-28')).toBeTruthy()
    expect(Array.from(container.querySelectorAll('input[type="radio"]')).some(r => (r as HTMLInputElement).checked)).toBe(false)
    fireEvent.click(within(container.querySelector('[data-option="i-2"]') as HTMLElement).getByRole('radio'))
    fireEvent.click(screen.getByText(DO_LINK))
    expect(links()).toEqual([])
    expect(screen.getByText('Iznosi ne mogu da se uporede: faktura 30.707,57 RSD, kamata rate 262,01 EUR; kurs NBS za 28.11.2026. nije dostupan, pa razlika nije izračunata. Ipak povezati?')).toBeTruthy()
  })

  it('proposes a link across currencies for a 0,07 EUR miss, within the conversion tolerance', async () => {
    ;(global as any).__db.credits = credits(BANK_PIB)
    ;(global as any).__db.sef_inbox = [{ ...inDinars, amount: 30715.78 }]
    const { container } = show()
    expect(await screen.findByText(/^Predlog: poveži sa kreditom „Obrtni kredit“ · rata #2/)).toBeTruthy()
    expect(screen.queryByTestId('remembered-pib')).toBeNull()
    expect(screen.queryByText(/Provizije banke/)).toBeNull()
    fireEvent.click(screen.getByText(LINK))
    expect(within(container.querySelector('[data-option="i-2"]') as HTMLElement).getByText('Predlog')).toBeTruthy()
    expect(screen.getByText('faktura 30.715,78 RSD ≈ 262,08 EUR po srednjem kursu NBS za 28.11.2026. (1 EUR = 117,2000 RSD), '
      + 'kamata rate 262,01 EUR, razlika 0,07 EUR (u okviru tolerancije preračuna od 1,31 EUR)')).toBeTruthy()
    // Not to the cent, so still asked twice.
    fireEvent.click(screen.getByText(DO_LINK))
    expect(links()).toEqual([])
    expect(screen.getByText(/^Iznosi se razlikuju: .*\. Ipak povezati\?$/)).toBeTruthy()
  })

  it('a fee invoice in dinars from the remembered bank proposes nothing, and says the PIB is remembered', async () => {
    ;(global as any).__db.credits = credits(BANK_PIB)
    ;(global as any).__db.sef_inbox = [{ ...inDinars, amount: 1500 }]
    show()
    await screen.findByText('Larkspur banka')
    await waitFor(() => expect((global as any).__db.ratesAsked).toEqual(['2026-11-28']))
    expect(await screen.findByTestId('remembered-pib')).toBeTruthy()
    expect(screen.queryByText(/Predlog: poveži/)).toBeNull()
    expect(screen.queryByText(/Provizije banke/)).toBeNull()
  })

  it('proposes the link from a remembered PIB once the rate shows the match', async () => {
    ;(global as any).__db.credits = credits(BANK_PIB)
    show()
    expect(await screen.findByText('Predlog: poveži sa kreditom „Obrtni kredit“ · rata #2 · dospeva 30. nov 2026. · kamata 262,01 EUR. PIB ovog dobavljača je zapamćen na tom kreditu.')).toBeTruthy()
    expect(screen.queryByText(/Provizije banke/)).toBeNull()
  })
})

describe('the proposal from a remembered PIB', () => {
  it('keeps the classification proposal while no credit remembers the bank', async () => {
    show()
    await screen.findByText('Kancelarija Kamenolom')
    expect(within(rowOf('Larkspur banka')).getByText(/Predlog: Bankarske usluge › Provizije banke/)).toBeTruthy()
  })

  it('proposes the instalment instead, once the PIB is remembered on a credit', async () => {
    ;(global as any).__db.credits = credits(BANK_PIB)
    const { container } = show()
    await screen.findByText('Kancelarija Kamenolom')
    const row = rowById(container, 'p1')
    expect(within(row).getByText('Predlog: poveži sa kreditom „Obrtni kredit“ · rata #2 · dospeva 30. nov 2026. · kamata 262,01 EUR. PIB ovog dobavljača je zapamćen na tom kreditu.')).toBeTruthy()
    expect(within(row).queryByText(/Provizije banke/)).toBeNull()
  })

  /**
   * The bank also sends fee invoices, and a fee linked instead of booked would
   * leave P&L. So a remembered PIB proposes a link only when an instalment's
   * interest is the amount, to within a cent.
   */
  it('says the PIB is remembered instead of proposing a category, and chooses nothing, when no instalment matches', async () => {
    ;(global as any).__db.credits = credits(BANK_PIB)
    ;(global as any).__db.sef_inbox = [{ ...pending, amount: 263 }]
    const { container } = show()
    await screen.findByText('Larkspur banka')
    expect(screen.getByTestId('remembered-pib').textContent).toBe(
      'PIB ovog dobavljača je zapamćen na kreditu „Obrtni kredit“, ali kamata nijedne rate se ne poklapa sa iznosom. '
      + 'Ako je ovo kamata, povežite je sa ratom; ako je provizija ili druga usluga banke, proknjižite je.')
    expect(screen.queryByText(/Provizije banke/)).toBeNull()
    expect(screen.queryByText(/Predlog: poveži/)).toBeNull()
    fireEvent.click(screen.getByText(LINK))
    expect(Array.from(container.querySelectorAll('input[type="radio"]')).some(r => (r as HTMLInputElement).checked)).toBe(false)
  })
})

describe('the edges', () => {
  it('says so, and still lists the inbox, when the credits cannot be read', async () => {
    ;(global as any).__db.failing = 'credits'
    show()
    expect(await screen.findByText(/Krediti nisu mogli da se pročitaju, pa fakture ne mogu da se povežu sa ratom: pad veze/)).toBeTruthy()
    expect(screen.getByText('Kancelarija Kamenolom')).toBeTruthy()
  })

  it('says so when the instalment a row is linked to cannot be read', async () => {
    ;(global as any).__db.sef_inbox = [{ ...linked, credit_installment_id: 'i-gone' }]
    show()
    await screen.findByText(/Ništa ne čeka/)
    fireEvent.click(chip(/^Vezane za kredite/))
    expect(screen.getByText('Povezana sa ratom kredita koja ne može da se pročita.')).toBeTruthy()
  })
})
