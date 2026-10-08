import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreditDialog, CreditRow } from './Credits'

// A client that records what it was asked to write and agrees to all of it.
// These tests are about WHAT the dialog sends, which is the part that decides
// whether a correction corrects or quietly creates a second credit.
jest.mock('../supabase', () => {
  const calls: any[] = []
  const make = (table: string) => {
    const rec: any = { table, eq: [] as any[] }
    const chain: any = {
      insert: (p: any) => { rec.op = 'insert'; rec.payload = p; calls.push(rec); return chain },
      update: (p: any) => { rec.op = 'update'; rec.payload = p; calls.push(rec); return chain },
      select: () => chain,
      eq: (c: string, v: any) => { rec.eq.push([c, v]); return chain },
      order: () => chain,
      single: () => Promise.resolve({ data: { id: 'comp-1' }, error: null }),
      // The one company the book is kept for, as the companies hook reads it.
      then: (f: any) => Promise.resolve({
        data: table === 'companies' ? [{ id: 'comp-1', name: 'Test Company doo' }] : null,
        error: null,
      }).then(f),
    }
    return chain
  }
  return { supabase: { from: make }, __calls: calls }
})

const written = () => (jest.requireMock('../supabase') as any).__calls as any[]

beforeEach(() => { written().length = 0 })

const show = () => render(<CreditDialog onClose={() => {}} onSaved={() => {}} />)

const nameBox = () => screen.getByPlaceholderText(/Intesa 100k/) as HTMLInputElement

describe('typing into the new credit form', () => {
  /**
   * THE BUG, stated as the thing that must not happen.
   *
   * `Field` was declared inside the dialog, so every keystroke produced a new
   * function and therefore a new component TYPE. React compares types by
   * reference: a new type is not the same component re-rendered, it is the old
   * one unmounted and a new one mounted. The input the caret was in stopped
   * existing, and the caret went with it — one letter per click, for ever.
   *
   * Identity of the DOM node is the precise statement of that: the box after
   * a keystroke has to be the same box as before it.
   */
  it('keeps the same input element across a keystroke', () => {
    show()
    const before = nameBox()
    fireEvent.change(before, { target: { value: 'I' } })
    expect(nameBox()).toBe(before)
  })

  /** The symptom as the owner met it: the caret has to survive. */
  it('leaves the caret in the box it was typed into', () => {
    show()
    const box = nameBox()
    box.focus()
    fireEvent.change(box, { target: { value: 'I' } })
    expect(document.activeElement).toBe(nameBox())
  })

  /** And what that cost: a second letter has to land beside the first. */
  it('accepts a whole word without being clicked again', () => {
    show()
    for (const upto of ['I', 'In', 'Int', 'Inte']) {
      fireEvent.change(nameBox(), { target: { value: upto } })
    }
    expect(nameBox().value).toBe('Inte')
  })

  /**
   * The same fault reached every other box in the dialog, since they all go
   * through `Field`. One of the others, to say the fix is not local to the
   * first one.
   */
  it('keeps the bank box too', () => {
    show()
    const bank = screen.getByPlaceholderText(/Intesa Banka/) as HTMLInputElement
    fireEvent.change(bank, { target: { value: 'U' } })
    expect(screen.getByPlaceholderText(/Intesa Banka/)).toBe(bank)
  })
})

// ── Correcting a credit that already exists ────────────────────────────────

const loan = (over: Record<string, any> = {}) => ({
  id: 'c1', company_id: 'comp-1', name: 'Intesa 100k — Sep 2025', bank: 'Intesa Banka',
  principal_amount: 100000, currency: 'EUR', interest_rate: 5.5, rate_type: 'fixed',
  rate_description: '5.5% fixed', disbursement_date: '2025-09-01',
  first_payment_date: '2025-10-31', last_payment_date: '2027-09-30',
  monthly_annuity: 4500, total_installments: 24, status: 'active', notes: null,
  kind: 'annuity', ...over,
}) as any

const edit = (over: Record<string, any> = {}, hasSchedule = false) => render(
  <CreditDialog credit={loan(over)} hasSchedule={hasSchedule}
    onClose={() => {}} onSaved={() => {}} />)

describe('correcting a credit', () => {
  /**
   * The whole point of the change. A credit was write-once: a rate left blank,
   * or typed wrongly, was wrong for good, and the only way to put it right was
   * to delete the credit — and its schedule with it.
   */
  it('opens with what the credit already says', () => {
    edit()
    expect(nameBox().value).toBe('Intesa 100k — Sep 2025')
    expect((screen.getByPlaceholderText('5.5') as HTMLInputElement).value).toBe('5.5')
    expect((screen.getByPlaceholderText('100000') as HTMLInputElement).value).toBe('100000')
  })

  /** A blank rate is the case the owner hit, and it has to be fillable. */
  it('lets a missing interest rate be typed in', async () => {
    edit({ interest_rate: null })
    const rate = screen.getByPlaceholderText('5.5') as HTMLInputElement
    expect(rate.value).toBe('')
    fireEvent.change(rate, { target: { value: '6.25' } })
    fireEvent.click(screen.getByText('Sačuvaj izmene'))
    await waitFor(() => expect(written()).toHaveLength(1))
    expect(written()[0].payload.interest_rate).toBe(6.25)
  })

  /**
   * CORRECTS, never duplicates. An edit that reached `insert` would leave the
   * old credit on the books beside the new one, both counted, the debt doubled
   * — and the schedule still hanging off the stale one.
   */
  it('updates the row it was given rather than writing a second credit', async () => {
    edit()
    fireEvent.change(nameBox(), { target: { value: 'Intesa 100k — corrected' } })
    fireEvent.click(screen.getByText('Sačuvaj izmene'))
    await waitFor(() => expect(written()).toHaveLength(1))
    const call = written()[0]
    expect(call.op).toBe('update')
    expect(call.table).toBe('credits')
    expect(call.eq).toContainEqual(['id', 'c1'])
    expect(call.payload.name).toBe('Intesa 100k — corrected')
  })

  /**
   * Two columns are decided when a credit is created and must survive every
   * correction. Writing `active` back would reopen a loan somebody closed,
   * and the page would start counting a settled debt again.
   */
  it('leaves status and company alone', async () => {
    edit({ status: 'closed' })
    fireEvent.click(screen.getByText('Sačuvaj izmene'))
    await waitFor(() => expect(written()).toHaveLength(1))
    expect(written()[0].payload).not.toHaveProperty('status')
    expect(written()[0].payload).not.toHaveProperty('company_id')
  })

  /** A new credit still goes in as one, under the company, active. */
  it('still inserts when there is nothing to correct', async () => {
    show()
    // The company arrives on its own read; saving before it would have no home.
    await act(async () => {})
    fireEvent.change(nameBox(), { target: { value: 'Unicredit 50k' } })
    fireEvent.change(screen.getByPlaceholderText(/Intesa Banka/), { target: { value: 'Unicredit' } })
    fireEvent.change(screen.getByPlaceholderText('100000'), { target: { value: '50000' } })
    fireEvent.click(screen.getByText('Sačuvaj kredit'))
    await waitFor(() => expect(written()).toHaveLength(1))
    expect(written()[0].op).toBe('insert')
    expect(written()[0].payload.status).toBe('active')
    expect(written()[0].payload.company_id).toBe('comp-1')
  })

  /**
   * THE KIND IS NOT A FIELD once there is a schedule.
   *
   * Turning an amortising loan with twenty-four instalments into a revolving
   * line nulls the annuity, the rate and the count that explain those rows and
   * leaves the rows themselves behind. The refusal is visible, not silent.
   */
  it('refuses to change the kind once instalments exist', () => {
    edit({}, true)
    expect((screen.getByText('Revolving').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/vrsta je zaključana dok postoji plan otplate/i)).toBeTruthy()
  })

  /** With no schedule behind it, a credit filed under the wrong kind is just
   *  a typo, and typos are correctable. */
  it('allows the kind to be changed while nothing has been scheduled', () => {
    edit({}, false)
    const revolving = screen.getByText('Revolving').closest('button') as HTMLButtonElement
    expect(revolving.disabled).toBe(false)
    fireEvent.click(revolving)
    expect(screen.getByText('Dospeće *')).toBeTruthy()
  })

  /** It has to be obvious which credit is open, since the page has eleven. */
  it('says which credit is being corrected', () => {
    edit()
    expect(screen.getByText('Izmena kredita')).toBeTruthy()
    expect(screen.getByText('Intesa 100k — Sep 2025')).toBeTruthy()
  })
})

// ── Finding the thing at all ───────────────────────────────────────────────
//
// A control that has to be hunted for is a control that is not there. The last
// pair of row actions shipped as 35%-opacity emoji and the owner reported
// seeing no change at all, so this one is a named button and these tests say
// so out loud.

describe('reaching the credit from its row', () => {
  const row = (onEdit = () => {}) => render(
    <CreditRow credit={loan()} installments={[]} onRefresh={() => {}} onEdit={onEdit} />)

  it('offers Izmeni kredit once the row is opened', () => {
    row()
    fireEvent.click(screen.getByText('Intesa 100k — Sep 2025'))
    expect(screen.getByText('Izmeni kredit')).toBeTruthy()
  })

  it('opens the credit, not an instalment', () => {
    const asked = jest.fn()
    row(asked)
    fireEvent.click(screen.getByText('Intesa 100k — Sep 2025'))
    fireEvent.click(screen.getByText('Izmeni kredit'))
    expect(asked).toHaveBeenCalledTimes(1)
  })

  /**
   * Two edits a row apart. Without a word distinguishing them, "Edit" beside
   * "✎ Edit" reads as the same button twice, and the one that changes a single
   * month gets used for the one that changes the loan.
   */
  it('says which edit is which', () => {
    row()
    fireEvent.click(screen.getByText('Intesa 100k — Sep 2025'))
    expect(screen.getByText(/u redu menja samo jednu ratu/)).toBeTruthy()
  })
})
