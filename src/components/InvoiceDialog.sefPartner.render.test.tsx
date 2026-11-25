import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InvoiceDialog from './InvoiceDialog'

// A bill booked from SEF and the partner it lands on: a partner made from
// here is made with the bill's PIB, and a partner that lacks one is given it
// by the save — never over one it already has. Every name and number here is
// invented.

const mockState = {
  partners: [] as any[],
  inserted: [] as { table: string; payload: any }[],
  updates: [] as { table: string; patch: any; filters: any[] }[],
  updateError: null as string | null,
  dialogProps: null as any,
  /** What the stubbed form saves, over what it was opened on. */
  createdOver: {} as Record<string, unknown>,
  transactions: [] as any[],
  /** Every write, in the order it was made. */
  sequence: [] as string[],
}

function mockQuery(table: string) {
  const result = () => {
    if (table === 'pl_categories') return { data: [{ id: 'cat1', name: 'Materijal', type: 'expense', sort_order: 1 }], error: null }
    if (table === 'departments') return { data: [{ id: 'd1', name: 'Uprava', sort_order: 1 }], error: null }
    if (table === 'transactions') return { data: mockState.transactions, error: null }
    return { data: [], error: null }
  }
  const q: any = {}
  let update: { table: string; patch: any; filters: any[] } | null = null
  for (const m of ['neq', 'gt', 'order', 'limit', 'ilike', 'in']) q[m] = () => q
  q.eq = (c: string, v: any) => { update?.filters.push(['eq', c, v]); return q }
  q.is = (c: string, v: any) => { update?.filters.push(['is', c, v]); return q }
  q.not = (c: string, op: string, v: any) => { update?.filters.push(['not', c, op, v]); return q }
  q.update = (patch: any) => {
    update = { table, patch, filters: [] }
    mockState.updates.push(update)
    mockState.sequence.push(`update ${table}`)
    return q
  }
  q.select = () => {
    if (update && table === 'partners') {
      return Promise.resolve(mockState.updateError
        ? { data: null, error: { message: mockState.updateError } }
        : { data: [{ id: 'x' }], error: null })
    }
    return q
  }
  q.range = () => Promise.resolve(result())
  q.insert = (payload: any) => {
    mockState.inserted.push({ table, payload })
    mockState.sequence.push(`insert ${table}`)
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: `${table}-new`, ...payload }, error: null })
    return ins
  }
  q.maybeSingle = async () => result()
  q.single = async () => result()
  q.then = (ok: any, bad: any) => Promise.resolve(update ? { data: [{ id: 'x' }], error: null } : result()).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: { from: (t: string) => mockQuery(t), rpc: () => Promise.resolve({ data: null, error: null }) },
}))
jest.mock('../contexts/CompaniesContext', () => ({
  useCompanies: () => ({ companies: [{ id: 'co1', name: 'Firma', currencies: ['RSD'] }], defaultCompany: { id: 'co1', name: 'Firma' }, showPicker: false }),
}))
jest.mock('../contexts/ProjectsContext', () => ({ useProjects: () => ({ projects: [] }) }))
jest.mock('../services/allPartners', () => ({ fetchAllPartners: async () => mockState.partners }))
jest.mock('../services/quickFillStore', () => ({ fetchScripts: async () => [], saveScript: async () => ({}), whyNotSavable: () => null }))
jest.mock('../services/saveSplits', () => ({
  loadSplits: async () => [],
  saveSplits: async () => { mockState.sequence.push('splits'); return { ok: true, lines: 0, message: '' } },
}))
jest.mock('../services/writeOrder', () => ({
  ...jest.requireActual('../services/writeOrder'),
  reallocateInvoiceLinks: async () => { mockState.sequence.push('links'); return { ok: true, message: '' } },
}))
jest.mock('./SplitEditor', () => () => null)
jest.mock('./ProjectSelect', () => () => null)
jest.mock('./PartnerDialog', () => (p: any) => {
  mockState.dialogProps = p
  // Saves the partner as the form would, with what was left in it: here the
  // registration number was cleared before saving.
  return (
    <div data-testid="partner-dialog">
      <button onClick={() => p.onSaved({ id: 'p-new', name: p.initialName, tax_id: p.initialTaxId, registration_number: null, ...mockState.createdOver })}>stub create</button>
    </div>
  )
})

const supplier = {
  name: 'Alfa Doo Beograd', taxId: '100000001', registrationNumber: '20000001',
  address: 'Test ulica 1', city: 'Testgrad', matchedPartnerId: 'p1',
}

/** A bill as the SEF inbox hands it over: no id, everything filled in. */
const draft = (over: Record<string, unknown> = {}) => ({
  company_id: 'co1', partner_id: 'p1', partners: { name: 'Alfa Doo' },
  invoice_number: 'F-1/26', invoice_date: '2026-10-10', type: 'expense',
  currency: 'RSD', amount: 12000, exchange_rate: 1, eur_rate: 117.2,
  pl_category: 'Materijal', department: 'Uprava',
  ...over,
})

const FILL = 'PIB 100000001 i matični broj 20000001 sa fakture biće upisani kod ovog partnera, koji ih nema.'
const next = () => fireEvent.click(screen.getByText('Dalje'))
const postButton = () => screen.getByText(/Proknjiži fakturu|Sačuvaj izmene/).closest('button') as HTMLButtonElement
const post = () => fireEvent.click(postButton())
const partnerUpdates = () => mockState.updates.filter(u => u.table === 'partners')
const invoicesInserted = () => mockState.inserted.filter(i => i.table === 'invoices')

beforeEach(() => {
  mockState.partners = [{ id: 'p1', name: 'Alfa Doo', tax_id: null, registration_number: null }]
  mockState.inserted = []
  mockState.updates = []
  mockState.updateError = null
  mockState.dialogProps = null
  mockState.createdOver = {}
  mockState.transactions = []
  mockState.sequence = []
})

describe('the partner of a bill booked from SEF', () => {
  it("says under the partner that the bill's PIB will be saved on it", async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    expect(await screen.findByText(FILL)).toBeInTheDocument()
  })

  it('the save writes them, each only where the partner is still empty', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    await screen.findByText(FILL)
    next(); next(); next()
    post()
    await waitFor(() => expect(partnerUpdates()).toHaveLength(2))
    expect(invoicesInserted()).toHaveLength(1)
    expect(partnerUpdates().map(u => [u.patch, u.filters])).toEqual([
      [{ tax_id: '100000001' }, [['eq', 'id', 'p1'], ['is', 'tax_id', null]]],
      [{ registration_number: '20000001' }, [['eq', 'id', 'p1'], ['is', 'registration_number', null]]],
    ])
  })

  it('a partner that has its PIB is told nothing and given nothing', async () => {
    mockState.partners = [{ id: 'p1', name: 'Alfa Doo', tax_id: '100000777', registration_number: '20000777' }]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    await screen.findByDisplayValue('Alfa Doo')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(invoicesInserted()).toHaveLength(1))
    expect(partnerUpdates()).toHaveLength(0)
  })

  it('a bill typed by hand changes no partner', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} />)
    await screen.findByDisplayValue('Alfa Doo')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(invoicesInserted()).toHaveLength(1))
    expect(partnerUpdates()).toHaveLength(0)
  })

  it('a refusal is reported, the invoice said to be saved, with no success screen and Post disabled', async () => {
    mockState.updateError = 'permission denied'
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    await screen.findByText(FILL)
    next(); next(); next()
    post()
    expect(await screen.findByText('Faktura je sačuvana, ali PIB i matični broj sa fakture nisu upisani kod partnera: permission denied')).toBeInTheDocument()
    expect(screen.getByText('Faktura JE proknjižena — F-1/26 je u knjigama')).toBeInTheDocument()
    expect(screen.queryByText(/^Faktura je (izmenjena|proknjižena)\.$/)).not.toBeInTheDocument()
    expect(postButton().disabled).toBe(true)
    expect(invoicesInserted()).toHaveLength(1)
    expect(screen.getByText('Ono što nije uspelo došlo je posle nje, a ponovno knjiženje bi samo dodalo drugu. Zatvorite ovo i upišite PIB u Partnerima.')).toBeInTheDocument()
    expect(screen.queryByText(/ispravite iz knjige faktura/)).not.toBeInTheDocument()
  })

  it('writes the partner last: after the invoice, its split and its links', async () => {
    mockState.transactions = [{
      id: 't1', transaction_date: '2026-10-05', is_advance: false, type: 'direct', tx_subtype: 'expense',
      amount: 12000, amount_rsd: 12000, amount_eur: 12000 / 117.2, currency: 'RSD', exchange_rate: 1,
      pl_category: 'Materijal', department: 'Uprava',
      banks: { id: 'b1', name: 'Test banka' }, partners: { id: 'p1', name: 'Alfa Doo' },
    }]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    await screen.findByText(FILL)
    fireEvent.click((await screen.findAllByText(/^2026-10-05/))[0])
    next(); next(); next()
    post()
    await waitFor(() => expect(partnerUpdates()).toHaveLength(2))
    expect(mockState.sequence.filter(w => w !== 'update transactions')).toEqual([
      'insert invoices', 'splits', 'links', 'update partners', 'update partners',
    ])
  })

  /** A partner picked by hand may be a catch-all; the supplier's PIB on it
   *  would pull every later bill of this supplier onto it. */
  it('a partner picked by hand is told nothing and given nothing', async () => {
    mockState.partners = [
      { id: 'p1', name: 'Alfa Doo', tax_id: null, registration_number: null },
      { id: 'p-misc', name: 'Razni dobavljači', tax_id: null, registration_number: null },
    ]
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ partner_id: 'p-misc', partners: { name: 'Razni dobavljači' } })} sefSupplier={{ ...supplier, matchedPartnerId: null }} />)
    await screen.findByDisplayValue('Razni dobavljači')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(invoicesInserted()).toHaveLength(1))
    expect(partnerUpdates()).toHaveLength(0)
  })

  it("a partner whose registration number is another company's is given nothing", async () => {
    mockState.partners = [{ id: 'p1', name: 'Alfa Doo', tax_id: null, registration_number: '20000002' }]
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={supplier} />)
    await screen.findByDisplayValue('Alfa Doo')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
  })

  it('a partner just created from the bill is completed by it', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ partner_id: null, partners: null })} sefSupplier={{ ...supplier, matchedPartnerId: null }} />)
    fireEvent.click(await screen.findByTitle('Dodaj novog partnera (pretraga NBS)'))
    fireEvent.click(await screen.findByText('stub create'))
    expect(await screen.findByText('Matični broj 20000001 sa fakture biće upisan kod ovog partnera, koji ga nema.')).toBeInTheDocument()
  })

  /** The form can be retyped into another company: that one is not "from
   *  the bill", and the bill must not complete it. */
  it('a partner created from the form but renamed and with its PIB cleared is given nothing', async () => {
    mockState.createdOver = { name: 'Gama Doo', tax_id: '' }
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ partner_id: null, partners: null })} sefSupplier={{ ...supplier, matchedPartnerId: null }} />)
    fireEvent.click(await screen.findByTitle('Dodaj novog partnera (pretraga NBS)'))
    fireEvent.click(await screen.findByText('stub create'))
    await screen.findByDisplayValue('Gama Doo')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(invoicesInserted()).toHaveLength(1))
    expect(partnerUpdates()).toHaveLength(0)
  })

  it('a partner created from the form and renamed, but keeping the PIB, is still completed', async () => {
    mockState.createdOver = { name: 'Alfa' }
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ partner_id: null, partners: null })} sefSupplier={{ ...supplier, matchedPartnerId: null }} />)
    fireEvent.click(await screen.findByTitle('Dodaj novog partnera (pretraga NBS)'))
    fireEvent.click(await screen.findByText('stub create'))
    expect(await screen.findByText('Matični broj 20000001 sa fakture biće upisan kod ovog partnera, koji ga nema.')).toBeInTheDocument()
  })

  /** A budget user's units share a PIB (JBKJS on the buyer). */
  it('a party marked skipFill is told nothing and given nothing, even when matched', async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft()} sefSupplier={{ ...supplier, skipFill: true }} />)
    await screen.findByDisplayValue('Alfa Doo')
    expect(screen.queryByText(/sa fakture biće upisan/)).not.toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(invoicesInserted()).toHaveLength(1))
    expect(partnerUpdates()).toHaveLength(0)
  })

  /** The sales inbox hands over the customer the same way. */
  it('a revenue invoice from SEF completes the customer the inbox matched', async () => {
    mockState.partners = [{ id: 'k1', name: 'Kupac Doo', tax_id: null, registration_number: null }]
    const customer = { name: 'Kupac Doo', taxId: '100000002', registrationNumber: '20000002', address: null, city: null, matchedPartnerId: 'k1' }
    const revenue = {
      company_id: 'co1', partner_id: 'k1', partners: { name: 'Kupac Doo' }, type: 'revenue',
      invoice_number: 'IF-15/2026', invoice_date: '2026-11-02', currency: 'RSD', amount: 120000,
      exchange_rate: 1, eur_rate: 117.2, revenue_kind: 'services', revenue_stream: 'Ostalo',
    }
    render(<InvoiceDialog onClose={() => {}} invoice={revenue} sefSupplier={customer} />)
    expect(await screen.findByText('PIB 100000002 i matični broj 20000002 sa fakture biće upisani kod ovog partnera, koji ih nema.')).toBeInTheDocument()
    next(); next(); next()
    post()
    await waitFor(() => expect(partnerUpdates()).toHaveLength(2))
    expect(invoicesInserted()[0].payload).toMatchObject({ type: 'revenue', partner_id: 'k1' })
    expect(partnerUpdates().map(u => [u.patch, u.filters])).toEqual([
      [{ tax_id: '100000002' }, [['eq', 'id', 'k1'], ['is', 'tax_id', null]]],
      [{ registration_number: '20000002' }, [['eq', 'id', 'k1'], ['is', 'registration_number', null]]],
    ])
  })

  it("a new partner is opened on the bill's supplier, PIB, registration number and address", async () => {
    render(<InvoiceDialog onClose={() => {}} invoice={draft({ partner_id: null, partners: null })} sefSupplier={supplier} />)
    fireEvent.click(await screen.findByTitle('Dodaj novog partnera (pretraga NBS)'))
    await screen.findByTestId('partner-dialog')
    expect(mockState.dialogProps).toMatchObject({
      initialName: 'Alfa Doo Beograd', initialTaxId: '100000001', initialRegistrationNumber: '20000001',
      initialAddress: 'Test ulica 1', initialCity: 'Testgrad',
    })
  })
})
