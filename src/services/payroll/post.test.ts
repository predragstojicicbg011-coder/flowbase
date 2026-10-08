import {
  postPlan, undoPosting, linkedInvoices, alreadyPostedMessage,
  PostStepFailure, type PostContext,
} from './post'
import type { PostingPlan } from './posting'

const CONTEXT: PostContext = {
  companyId: 'c1', paymentDate: '2026-09-05', dueDate: null,
  currency: 'RSD', eurRate: 117.3586,
}

const plan = (over: Partial<PostingPlan> = {}): PostingPlan => ({
  runKey: 'regular', month: '2026-08',
  invoices: [
    { kind: 'net', employeeId: 'e1', employeeName: 'A', partnerId: null,
      pl_category: 'Employee and Labour', pl_subcategory: 'Net Salaries',
      department: 'Dev', dept_subcategory: 'Eng', expense_description: 'A',
      cf_type: 'recurring', projects: [{ project_id: 'p1', amount: 1000 }],
      amount: 1000, pl_impact: true, note: 'net' },
    { kind: 'obligation_parent', employeeId: null, employeeName: '', partnerId: null,
      pl_category: 'Employee and Labour', pl_subcategory: 'Tax on salary',
      department: null, dept_subcategory: null, expense_description: 'Tax',
      cf_type: 'recurring', projects: [],
      amount: 400, pl_impact: false, note: 'parent' },
    { kind: 'obligation_child', employeeId: null, employeeName: 'A', partnerId: null,
      pl_category: 'Employee and Labour', pl_subcategory: 'Tax on salary',
      department: 'Dev', dept_subcategory: 'Eng', expense_description: 'A',
      cf_type: 'one_time', projects: [{ project_id: 'p1', amount: 400 }],
      amount: 400, pl_impact: true, parentRef: 'obligation', note: 'child' },
  ],
  transactions: [],
  expectedTotalCost: 1400,
  projectErrors: [],
  ...over,
})

/** A client that records what it was asked to write. */
function client(over: { claimError?: any; invoiceError?: any; txError?: any; linkError?: any } = {}) {
  const calls: any = { invoices: [], transactions: [], postings: [], updates: [], splits: [], splitDeletes: [] }
  let n = 0
  return {
    calls,
    from(table: string) {
      if (table === 'pl_splits') {
        const chain: any = {
          eq: (col: string, v: any) => { calls.splitDeletes.push([col, v]); return chain },
          in: (col: string, v: any) => { calls.splitDeletes.push([col, v]); return chain },
          select: async () => ({ data: [], error: null }),
          then: (res: any) => res({ data: null, error: null }),
        }
        return {
          delete: () => chain,
          insert(rows: any[]) {
            calls.splits.push(...rows)
            return { select: async () => ({ data: rows.map((_, i) => ({ id: `s-${i}` })), error: null }) }
          },
        }
      }
      if (table === 'payroll_postings') {
        return {
          insert(row: any) {
            calls.postings.push(row)
            return { select: () => ({ single: async () =>
              over.claimError ? { data: null, error: over.claimError }
                              : { data: { id: 'post-1' }, error: null } }) }
          },
          update(row: any) {
            calls.updates.push(row)
            return { eq: () => ({ select: async () =>
              ({ data: [{ id: 'post-1' }], error: over.linkError || null }) }) }
          },
          delete: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }),
        }
      }
      if (table === 'invoices') {
        return {
          insert(row: any) {
            calls.invoices.push(row)
            return { select: () => ({ single: async () =>
              over.invoiceError ? { data: null, error: over.invoiceError }
                                : { data: { id: `inv-${++n}` }, error: null } }) }
          },
          delete: () => ({ in: () => ({ select: async () => ({ data: [], error: null }) }) }),
        }
      }
      return {
        insert(row: any) {
          calls.transactions.push(row)
          return { select: () => ({ single: async () =>
            over.txError ? { data: null, error: over.txError }
                         : { data: { id: `tx-${++n}` }, error: null } }) }
        },
        delete: () => ({ in: () => ({ select: async () => ({ data: [], error: null }) }) }),
      }
    },
  }
}

describe('claiming the month', () => {
  it('writes the posting record BEFORE any invoice', async () => {
    // The unique index on it is what actually stops a double post. A check in
    // the page is raced straight past by a double click or a second tab.
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    expect(c.calls.postings).toHaveLength(1)
    expect(c.calls.postings[0].period_month).toBe('2026-08-01')
    expect(c.calls.postings[0].run_key).toBe('regular')
    // Payroll is posted in dinars: 1 RSD per RSD, and the day's EUR rate.
    expect(c.calls.postings[0].exchange_rate).toBe(1)
    expect(c.calls.postings[0].eur_rate).toBe(117.3586)
  })

  it('refuses a second posting and writes NOTHING', async () => {
    const c = client({ claimError: { code: '23505', message: 'duplicate key value' } })
    await expect(postPlan(c, plan(), CONTEXT, 'Salaries'))
      .rejects.toThrow(/je već proknjižen/)
    expect(c.calls.invoices).toHaveLength(0)
    expect(c.calls.transactions).toHaveLength(0)
  })

  it('recognises a unique violation by message as well as by code', async () => {
    // Different layers surface it differently, and mistaking it for an
    // ordinary failure would tell somebody to retry into a duplicate.
    const c = client({ claimError: { message: 'violates unique constraint "payroll_postings_once_idx"' } })
    await expect(postPlan(c, plan(), CONTEXT, 'Salaries'))
      .rejects.toThrow(/je već proknjižen/)
  })

  it('names an ordinary failure as the step it happened at', async () => {
    const c = client({ claimError: { code: '42501', message: 'permission denied' } })
    await expect(postPlan(c, plan(), CONTEXT, 'Salaries'))
      .rejects.toThrow(PostStepFailure)
  })
})

describe('the order the invoices go in', () => {
  it('writes the obligation parent before its children', async () => {
    // A child carries parent_invoice_id. Written first it is an orphan: a
    // filing that looks posted whose per-employee rows belong to nothing.
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    expect(c.calls.invoices[0].pl_impact).toBe(false)
    expect(c.calls.invoices[0].parent_invoice_id).toBeNull()
    const child = c.calls.invoices.find((i: any) => i.note.startsWith('child'))
    expect(child.parent_invoice_id).toBe('inv-1')
  })

  it('leaves an ordinary invoice with no parent', async () => {
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    const net = c.calls.invoices.find((i: any) => i.note.startsWith('net'))
    expect(net.parent_invoice_id).toBeNull()
  })

  it('records every id it created, so the posting can be undone', async () => {
    const c = client()
    const result = await postPlan(c, plan(), CONTEXT, 'Salaries')
    expect(result.invoiceIds).toHaveLength(3)
    expect(c.calls.updates[0].created_invoice_ids).toEqual(result.invoiceIds)
  })
})

describe('what each invoice carries', () => {
  it('puts the payment date, currency and book amounts on every one', async () => {
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    for (const i of c.calls.invoices) {
      expect(i.invoice_date).toBe('2026-09-05')
      expect(i.currency).toBe('RSD')
      expect(i.company_id).toBe('c1')
    }
    const net = c.calls.invoices.find((i: any) => i.note.startsWith('net'))
    for (const i of c.calls.invoices) {
      expect(i.exchange_rate).toBe(1)
      expect(i.eur_rate).toBe(117.3586)
      expect(i.amount_rsd).toBe(i.amount)
      expect('amount_usd' in i).toBe(false)
    }
    expect(net.amount_rsd).toBe(1000)
    expect(net.amount_eur).toBe(8.52)  // 1000 / 117.3586 = 8.5209 → 8.52
    expect(net.project_id).toBe('p1')
    expect('rev_alloc_type' in net).toBe(false)
    expect('opex_type' in net).toBe(false)
    expect(net.cf_type).toBe('recurring')
    expect(net.cf_next_month_est).toBe(1000)
  })

  it('writes nothing at all, not even the claim, when the EUR rate is not known', async () => {
    // A row without its euro figure would be right in dinars and missing from
    // every report read in euros — refused, rather than guessed or left null.
    const c = client()
    await expect(postPlan(c, plan(), { ...CONTEXT, eurRate: null }, 'Salaries'))
      .rejects.toThrow(/EUR/)
    expect(c.calls.postings).toHaveLength(0)
    expect(c.calls.invoices).toHaveLength(0)
  })

  it('stamps the posting id into the note, so an entry can be traced back', async () => {
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    expect(c.calls.invoices.every((i: any) => i.note.endsWith(' [knjiženje post-1]'))).toBe(true)
  })
})

describe('retained deductions', () => {
  it('posts them as a negative direct transaction', async () => {
    const c = client()
    await postPlan(c, plan({
      transactions: [{
        kind: 'retained_storno', employeeName: 'A',
        pl_category: 'Employee and Labour', pl_subcategory: 'FitPass expenses',
        department: 'Dev', dept_subcategory: 'Eng', expense_description: 'Fitpass',
        cf_type: 'recurring',
        amount: -1000, note: 'storno',
      }],
    }), CONTEXT, 'Salaries')
    expect(c.calls.transactions).toHaveLength(1)
    expect(c.calls.transactions[0].amount).toBe(-1000)
    expect(c.calls.transactions[0].amount_rsd).toBe(-1000)
    expect(c.calls.transactions[0].amount_eur).toBe(-8.52)  // the exact mirror of +1000
    expect(c.calls.transactions[0].exchange_rate).toBe(1)
    expect(c.calls.transactions[0].eur_rate).toBe(117.3586)
    expect(c.calls.transactions[0].status).toBe('posted')
    // Overhead: it cancels part of an expense that is not a site's.
    expect(c.calls.transactions[0].project_id).toBeNull()
    expect('rev_alloc_type' in c.calls.transactions[0]).toBe(false)
    expect('opex_type' in c.calls.transactions[0]).toBe(false)
  })
})

describe('when a write is refused partway', () => {
  it('names the step, so a retry does not land on top of what is there', async () => {
    const c = client({ invoiceError: { message: 'permission denied' } })
    await expect(postPlan(c, plan(), CONTEXT, 'Salaries'))
      .rejects.toThrow(/faktura za porez i doprinose/)
  })

  it('says the entries are fine when only the record of them failed', async () => {
    // The right way round to fail: recoverable, and never a second payroll.
    const c = client({ linkError: { message: 'nope' } })
    await expect(postPlan(c, plan(), CONTEXT, 'Salaries'))
      .rejects.toThrow(/Sve je ispravno proknjiženo/)
  })
})

describe('refusing to post a plan that does not add up', () => {
  it('checks the arithmetic again before writing anything', async () => {
    // Checked in the page too, but the one thing worse than refusing to post
    // is posting something that does not add up.
    const c = client()
    await expect(postPlan(c, plan({ expectedTotalCost: 9999 }), CONTEXT, 'Salaries'))
      .rejects.toThrow(/se ne slaže|Stavke iznose/)
    expect(c.calls.postings).toHaveLength(0)
  })

  it('REFUSES, writing nothing, when a system category the plan needed is not set', async () => {
    // `planFor` collects the unset roles; the write checks them again, first.
    const c = client()
    const why = 'Sistemska kategorija „Neto zarade“ nije podešena. '
      + 'Podesite je u Podešavanja → Sistemske kategorije.'
    await expect(postPlan(c, plan({ classificationErrors: [why] }), CONTEXT, 'Salaries'))
      .rejects.toThrow('„Neto zarade“ nije podešena')
    expect(c.calls.postings).toHaveLength(0)
    expect(c.calls.invoices).toHaveLength(0)
    expect(c.calls.transactions).toHaveLength(0)
  })

  it('refuses a row with no P&L heading, however the plan was built', async () => {
    const c = client()
    const headless = plan()
    headless.invoices = headless.invoices.map(i => i.kind === 'net' ? { ...i, pl_subcategory: '' } : i)
    await expect(postPlan(c, headless, CONTEXT, 'Salaries')).rejects.toThrow(/nema P&L kategoriju/)
    expect(c.calls.postings).toHaveLength(0)
    expect(c.calls.invoices).toHaveLength(0)
  })
})

describe('undoPosting', () => {
  /** A client that records the order it was asked to delete things in. */
  const undoClient = (over: { links?: any[]; deleteError?: any; thawError?: any } = {}) => {
    const order: string[] = []
    const updates: any[] = []
    return {
      order, updates,
      from(table: string) {
        if (table === 'invoice_transaction_links') {
          return { select: () => ({ in: async () => ({ data: over.links || [], error: null }) }) }
        }
        if (table === 'payroll_runs') {
          return {
            update(row: any) {
              updates.push(row)
              return { eq: () => ({ select: async () =>
                ({ data: [{ id: 'r1' }], error: over.thawError || null }) }) }
            },
          }
        }
        const done = async () => {
          order.push(table)
          return { data: [], error: table === 'invoices' ? (over.deleteError || null) : null }
        }
        return { delete: () => ({
          in: () => ({ select: done }),
          eq: () => ({ select: done, in: () => ({ select: done }) }),
        }) }
      },
    }
  }

  const posting = {
    id: 'p1', run_id: 'r1',
    created_invoice_ids: ['i1'], created_transaction_ids: ['t1'],
  }

  it('REFUSES while an invoice is matched to a bank payment', async () => {
    // Deleting it would take the allocation with it and leave the payment
    // sitting in the ledger against nothing — reconciled yesterday,
    // unexplained today, and the bank statement gives no clue why.
    const c = undoClient({ links: [{ invoice_id: 'i1', transaction_id: 'tx1', allocated_amount: 500 }] })
    await expect(undoPosting(c, posting)).rejects.toThrow(/uparen[ae] sa plaćanjem iz izvoda/)
    expect(c.order).toEqual([])
  })

  it('says how many, and tells somebody where to detach them', async () => {
    const c = undoClient({ links: [
      { invoice_id: 'i1', transaction_id: 'tx1', allocated_amount: 500 },
      { invoice_id: 'i1', transaction_id: 'tx2', allocated_amount: 200 },
    ] })
    // Two links on one invoice is one invoice, not two.
    await expect(undoPosting(c, posting)).rejects.toThrow(/^1 faktura je uparena sa plaćanjem/)
    await expect(undoPosting(c, posting)).rejects.toThrow(/raskinite uparivanje na transakciji/)
  })

  it('removes the entries before freeing the month, and thaws the run last', async () => {
    // The other order frees the month with its invoices still in place, and a
    // second posting lands on top of the first.
    const c = undoClient()
    await undoPosting(c, posting)
    expect(c.order).toEqual(['pl_splits', 'invoices', 'transactions', 'payroll_postings'])
    expect(c.updates[0]).toMatchObject({ status: 'draft', posted_at: null })
  })

  it('keeps the month claimed when the invoices could not be removed', async () => {
    const c = undoClient({ deleteError: { message: 'locked period' } })
    await expect(undoPosting(c, posting)).rejects.toThrow(/i dalje označen kao proknjižen/)
  })

  it('says the entries are gone when only the unlock failed', async () => {
    // The one step that may fail without losing anything: a run left locked
    // with no entries behind it refuses to recalculate, which is annoying and
    // recoverable. Every other order loses something.
    const c = undoClient({ thawError: { message: 'nope' } })
    await expect(undoPosting(c, posting)).rejects.toThrow(/i dalje zaključan/)
    expect(c.order).toEqual(['pl_splits', 'invoices', 'transactions', 'payroll_postings'])
  })

  it('does not look for a run to thaw when the posting has none', async () => {
    const c = undoClient()
    await undoPosting(c, { ...posting, run_id: null })
    expect(c.updates).toEqual([])
  })
})

describe('linkedInvoices', () => {
  it('refuses to delete anything when it cannot even check', async () => {
    // Not knowing whether a payment is attached is not the same as knowing
    // none is, and the difference is a reconciled payment left dangling.
    const c: any = {
      from: () => ({ select: () => ({ in: async () =>
        ({ data: null, error: { message: 'permission denied' } }) }) }),
    }
    await expect(linkedInvoices(c, ['i1'])).rejects.toThrow(/Ništa nije obrisano/)
  })

  it('asks nothing when there are no invoices to ask about', async () => {
    const c: any = { from: () => { throw new Error('should not be called') } }
    expect(await linkedInvoices(c, [])).toEqual([])
  })
})

describe('alreadyPostedMessage', () => {
  it('says what a duplicate actually costs, not just that it is a duplicate', () => {
    const m = alreadyPostedMessage('2026-08', 'Salaries')
    expect(m).toContain('Ništa nije upisano')
    expect(m).toContain('ni sa čim ne uparuje')
  })
})

describe('what a final month tells the forecast', () => {
  it('expects nothing next month from a one-off', async () => {
    // A salary left as recurring goes on being predicted every month for
    // somebody who has gone, silently, for as long as the forecast runs.
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    const child = c.calls.invoices.find((i: any) => i.note.startsWith('child'))
    expect(child.cf_type).toBe('one_time')
    expect(child.cf_next_month_est).toBe(0)
  })
})

describe('projects', () => {
  const shared = (): PostingPlan => plan({
    invoices: [
      { kind: 'net', employeeId: 'e1', employeeName: 'A', partnerId: null,
        pl_category: 'Employee and Labour', pl_subcategory: 'Net Salaries',
        department: 'Dev', dept_subcategory: 'Eng', expense_description: 'A',
        cf_type: 'recurring',
        projects: [
          { project_id: 'p1', amount: 600.33 },
          { project_id: 'p2', amount: 300.33 },
          { project_id: null, amount: 99.34 },
        ],
        amount: 1000, pl_impact: true, note: 'net' },
    ],
    expectedTotalCost: 1000,
  })

  it('writes a shared invoice once, with no project of its own, and one split line per project', async () => {
    const c = client()
    await postPlan(c, shared(), CONTEXT, 'Salaries')
    expect(c.calls.invoices).toHaveLength(1)
    expect(c.calls.invoices[0].project_id).toBeNull()
    expect(c.calls.invoices[0].amount).toBe(1000)
    expect(c.calls.splits.map((r: any) => r.project_id)).toEqual(['p1', 'p2', null])
    expect(c.calls.splits.every((r: any) => r.source === 'invoice' && r.source_id === 'inv-1')).toBe(true)
    expect(c.calls.splits.every((r: any) => r.department === 'Dev' && r.pl_subcategory === 'Net Salaries')).toBe(true)
  })

  it('makes the split lines add up to the invoice in the document currency, dinars and euros', async () => {
    const c = client()
    await postPlan(c, shared(), CONTEXT, 'Salaries')
    const inv = c.calls.invoices[0]
    const sum = (k: string) => Math.round(c.calls.splits.reduce((s: number, r: any) => s + r[k], 0) * 100) / 100
    expect(sum('amount')).toBe(inv.amount)
    expect(sum('amount_rsd')).toBe(inv.amount_rsd)
    expect(sum('amount_eur')).toBe(inv.amount_eur)
  })

  it('writes no split for an invoice on one project', async () => {
    const c = client()
    await postPlan(c, plan(), CONTEXT, 'Salaries')
    expect(c.calls.splits).toHaveLength(0)
  })

})
