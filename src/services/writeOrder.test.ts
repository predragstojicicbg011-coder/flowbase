import {
  planDelete, reportStepFailure, reportLinkFailure, isMissingFunction,
  DELETE_STEP_ORDER, LINK_STEP_ORDER,
  deleteTransactionSafely, deleteTransactionInSteps, reallocateInvoiceLink,
  reportPostFailure, softDeleteRow, runWrite,
  type SupabaseLike,
} from './writeOrder'

// ─── A Supabase that behaves like PostgREST ──────────────────────────────────
//
// Faithful in the three respects these tests are about:
//
//   1. supabase-js DOES NOT THROW. Every refusal comes back as
//      `{ data: null, error }` and the `await` resolves. This is the whole
//      reason the faults being fixed here went unnoticed: the dialog's
//      `try/catch` was dead code for exactly the errors it existed to catch.
//
//   2. An update or a delete that matches NOTHING is a success. 200, no error,
//      no rows. Indistinguishable from doing the work, unless you ask for the
//      representation back — or, for a soft delete, check that the row went
//      away.
//
//   3. The restrictive `<table>_hide_deleted` policy from migration
//      20260826120000 is applied on every read. A row that has just been
//      soft-deleted is invisible to the very next select, which is what makes
//      `.select('id')` the wrong confirmation for a soft delete and the right
//      one everywhere else.

interface Injected { message: string; code?: string }

interface MockDb {
  rows: Record<string, any[]>
  /** Failures to inject, keyed `table:op` — e.g. `transactions:update`. */
  errors: Record<string, Injected>
  rpc: { missing?: boolean; error?: Injected; data?: any }
  /** Every write and read that reached the fake server, in order. */
  calls: { table: string; op: string }[]
  rpcCalls: { fn: string; args: any }[]
}

const freshDb = (): MockDb => ({ rows: {}, errors: {}, rpc: {}, calls: [], rpcCalls: [] })

const matches = (row: any, f: any): boolean => {
  const v = row[f.col]
  switch (f.op) {
    case 'eq': return v === f.val
    case 'neq': return v !== f.val
    case 'in': return (f.val as any[]).includes(v)
    default: return true
  }
}

function makeClient(db: MockDb): SupabaseLike {
  const from = (table: string): any => {
    const filters: any[] = []
    let op: string = 'select'
    let payload: any = null
    let wantsOne: 'single' | 'maybeSingle' | null = null

    const fail = (): Injected | undefined => db.errors[`${table}:${op}`]

    const run = () => new Promise<any>(resolve => setTimeout(() => {
      db.calls.push({ table, op })
      const err = fail()
      if (err) { resolve({ data: null, error: err, count: null }); return }

      const all = db.rows[table] || []

      if (op === 'select') {
        // The restrictive hide-deleted policy.
        const visible = all.filter(r => !r.deleted_at).filter(r => filters.every(f => matches(r, f)))
        if (wantsOne === 'maybeSingle') { resolve({ data: visible[0] ?? null, error: null }); return }
        if (wantsOne === 'single') {
          resolve(visible.length === 1
            ? { data: visible[0], error: null }
            : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } })
          return
        }
        resolve({ data: visible, error: null, count: visible.length })
        return
      }

      if (op === 'update') {
        // An update sees rows the SELECT policy hides? No — the policy is
        // restrictive for select only, so an already-deleted row is still
        // updatable. What it cannot do is come back in the representation.
        const hit = all.filter(r => filters.every(f => matches(r, f)))
        for (const r of hit) Object.assign(r, payload)
        // `.select(...)` after an update asks for the representation, and the
        // hide-deleted policy applies to it.
        const returned = hit.filter(r => !r.deleted_at)
        resolve({ data: payload && filters.length ? returned : returned, error: null, count: hit.length })
        return
      }

      if (op === 'delete') {
        db.rows[table] = all.filter(r => !filters.every(f => matches(r, f)))
        resolve({ data: null, error: null, count: all.length - db.rows[table].length })
        return
      }

      if (op === 'upsert') {
        const list = db.rows[table] || (db.rows[table] = [])
        const existing = list.find(r => r.invoice_id === payload.invoice_id && r.transaction_id === payload.transaction_id)
        if (existing) Object.assign(existing, payload)
        else list.push({ id: `${table}-${list.length + 1}`, ...payload })
        resolve({ data: null, error: null })
        return
      }

      resolve({ data: null, error: null })
    }, 0))

    const builder: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => run().then(res, rej)
        if (prop === 'catch') return (rej: any) => run().catch(rej)
        if (prop === 'finally') return (cb: any) => run().finally(cb)
        if (prop === 'update') return (p: any) => { op = 'update'; payload = p; return builder }
        if (prop === 'insert') return (p: any) => { op = 'insert'; payload = p; return builder }
        if (prop === 'upsert') return (p: any) => { op = 'upsert'; payload = p; return builder }
        if (prop === 'delete') return () => { op = 'delete'; return builder }
        if (prop === 'single') return () => { wantsOne = 'single'; return builder }
        if (prop === 'maybeSingle') return () => { wantsOne = 'maybeSingle'; return builder }
        if (prop === 'eq') return (col: string, val: any) => { filters.push({ op: 'eq', col, val }); return builder }
        if (prop === 'neq') return (col: string, val: any) => { filters.push({ op: 'neq', col, val }); return builder }
        if (prop === 'in') return (col: string, val: any) => { filters.push({ op: 'in', col, val }); return builder }
        return () => builder
      },
    })
    return builder
  }

  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => new Promise<any>(resolve => setTimeout(() => {
      db.rpcCalls.push({ fn, args })
      if (db.rpc.missing) {
        resolve({ data: null, error: { message: 'Could not find the function public.delete_transaction_cascade in the schema cache', code: 'PGRST202' } })
        return
      }
      if (db.rpc.error) { resolve({ data: null, error: db.rpc.error }); return }
      resolve({ data: db.rpc.data ?? { invoice_links_removed: 0, installments_unlinked: 0 }, error: null })
    }, 0)),
  }
}

/** Two transactions, each with an invoice allocation and a settled instalment. */
const seed = (db: MockDb) => {
  db.rows.transactions = [
    { id: 'tx-1', company_id: 'co-1', transaction_date: '2026-01-15', deleted_at: null },
    { id: 'tx-2', company_id: 'co-1', transaction_date: '2026-05-15', deleted_at: null },
  ]
  db.rows.invoice_transaction_links = [
    { id: 'l-1', invoice_id: 'inv-1', transaction_id: 'tx-1', allocated_amount: 100, allocated_amount_usd: 100 },
    { id: 'l-2', invoice_id: 'inv-2', transaction_id: 'tx-2', allocated_amount: 200, allocated_amount_usd: 200 },
  ]
  db.rows.credit_installments = [
    { id: 'i-1', transaction_id: 'tx-1', paid_amount: 100, status: 'paid', paid_date: '2026-01-15' },
    { id: 'i-2', transaction_id: 'tx-2', paid_amount: 200, status: 'paid', paid_date: '2026-05-15' },
  ]
  db.rows.feature_flags = [{ name: 'period_lock', enabled: true }]
  db.rows.closed_periods = []
}

const lock = (db: MockDb, period: string, company = 'co-1') => {
  db.rows.closed_periods = [{ id: 'cp-1', company_id: company, period }]
}

// ─── The decisions, on their own ─────────────────────────────────────────────

describe('planDelete', () => {
  const base = { transactionId: 'tx-1', companyId: 'co-1', transactionDate: '2026-01-15' }

  it('refuses a transaction whose month is closed for its company', () => {
    const plan = planDelete({ ...base, periodLockEnabled: true, closedPeriods: [{ company_id: 'co-1', period: '2026-01-01' }] })
    expect(plan.kind).toBe('refuse')
    if (plan.kind === 'refuse') {
      expect(plan.reason).toContain('2026-01')
      expect(plan.reason).toContain('nothing was deleted')
    }
  })

  it('allows it when the closed month belongs to a different company', () => {
    const plan = planDelete({ ...base, periodLockEnabled: true, closedPeriods: [{ company_id: 'co-2', period: '2026-01-01' }] })
    expect(plan.kind).toBe('proceed')
  })

  it('allows it when the closed month is a different month', () => {
    const plan = planDelete({ ...base, periodLockEnabled: true, closedPeriods: [{ company_id: 'co-1', period: '2026-02-01' }] })
    expect(plan.kind).toBe('proceed')
  })

  it('allows it when the global switch is off, even in a closed month', () => {
    const plan = planDelete({ ...base, periodLockEnabled: false, closedPeriods: [{ company_id: 'co-1', period: '2026-01-01' }] })
    expect(plan.kind).toBe('proceed')
  })

  it('proceeds when the pre-check could not run — the trigger is the enforcement', () => {
    const plan = planDelete({ ...base, periodLockEnabled: undefined, closedPeriods: undefined })
    expect(plan.kind).toBe('proceed')
  })

  it('puts the soft delete before anything that destroys a reference', () => {
    const plan = planDelete({ ...base, closedPeriods: [] })
    expect(plan.kind).toBe('proceed')
    if (plan.kind === 'proceed') {
      expect(plan.steps).toEqual(['transaction', 'invoiceLinks', 'installments'])
      expect(plan.steps.indexOf('transaction')).toBeLessThan(plan.steps.indexOf('invoiceLinks'))
      expect(plan.steps.indexOf('transaction')).toBeLessThan(plan.steps.indexOf('installments'))
    }
  })
})

describe('reportStepFailure', () => {
  it('says nothing was lost when the delete itself was refused', () => {
    const msg = reportStepFailure('transaction', 'Period 2026-01 je zakljucan')
    expect(msg).toContain('Period 2026-01 je zakljucan')
    expect(msg).toContain('untouched')
    expect(msg).toContain('nothing was lost')
  })

  it('names the invoice allocations left dangling when their removal failed', () => {
    const msg = reportStepFailure('invoiceLinks', 'network')
    expect(msg).toContain('The transaction was deleted')
    expect(msg).toContain('invoice allocations could not be removed')
    expect(msg).toContain('credit instalments were left alone')
  })

  it('names the instalments left dangling when their reset failed', () => {
    const msg = reportStepFailure('installments', 'network')
    expect(msg).toContain('credit')
    expect(msg).toContain('instalments it settled could not be reopened')
    expect(msg).toContain('Bank Credits')
  })

  it('reports a distinct sentence for every step in the order', () => {
    const seen = DELETE_STEP_ORDER.map(s => reportStepFailure(s, 'x'))
    expect(new Set(seen).size).toBe(DELETE_STEP_ORDER.length)
  })
})

describe('reportLinkFailure', () => {
  it('says the previous allocation is still there when the insert failed', () => {
    const msg = reportLinkFailure('insertReplacement', 'RLS')
    expect(msg).toContain('Nothing was removed')
    expect(msg).toContain('still allocated')
  })

  it('warns that the invoice counts both when the cleanup failed', () => {
    const msg = reportLinkFailure('removeSuperseded', 'RLS')
    expect(msg).toContain('counts both')
    expect(msg).toContain('more paid than it is')
  })

  it('writes the replacement before removing what it supersedes', () => {
    expect(LINK_STEP_ORDER).toEqual(['insertReplacement', 'removeSuperseded'])
  })
})

describe('isMissingFunction', () => {
  it('recognises PostgREST saying the function is not in the schema cache', () => {
    expect(isMissingFunction({ message: 'Could not find the function public.delete_transaction_cascade in the schema cache', code: 'PGRST202' })).toBe(true)
  })

  it('recognises Postgres saying the function does not exist', () => {
    expect(isMissingFunction({ message: 'function public.delete_transaction_cascade(uuid, uuid) does not exist', code: '42883' })).toBe(true)
  })

  it('does not mistake a closed period for a missing function', () => {
    expect(isMissingFunction({ message: 'Period 2026-01 je zakljucan za ovu firmu', code: '23514' })).toBe(false)
  })

  it('does not mistake an RLS denial for a missing function', () => {
    expect(isMissingFunction({ message: 'new row violates row-level security policy', code: '42501' })).toBe(false)
  })

  it('is false for no error at all', () => {
    expect(isMissingFunction(null)).toBe(false)
  })
})

// ─── Deleting a transaction, against the fake server ─────────────────────────

describe('deleteTransactionSafely — the atomic path', () => {
  let db: MockDb
  beforeEach(() => { db = freshDb(); seed(db) })

  it('does the whole delete in one call and touches no table from here', async () => {
    db.rpc.data = { invoice_links_removed: 1, installments_unlinked: 1 }
    const out = await deleteTransactionSafely(makeClient(db), { transactionId: 'tx-1', deletedBy: 'u-1' })

    expect(out.ok).toBe(true)
    expect(out.atomic).toBe(true)
    expect(out.invoiceLinksRemoved).toBe(1)
    expect(out.installmentsUnlinked).toBe(1)
    expect(db.rpcCalls).toEqual([{ fn: 'delete_transaction_cascade', args: { p_transaction_id: 'tx-1', p_deleted_by: 'u-1' } }])
    // Not one write from the client. The database did all three or none.
    expect(db.calls).toEqual([])
  })

  it('a locked period leaves every link intact and writes nothing', async () => {
    db.rpc.error = { message: 'Period 2026-01 je zakljucan za ovu firmu — izmjena nije dozvoljena.', code: '23514' }
    const out = await deleteTransactionSafely(makeClient(db), { transactionId: 'tx-1', deletedBy: 'u-1' })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual([])
    expect(out.message).toContain('zakljucan')
    expect(out.message).toContain('nothing was lost')
    // The fault this whole change is about: these three used to be gone.
    expect(db.rows.invoice_transaction_links).toHaveLength(2)
    expect(db.rows.credit_installments.find(i => i.id === 'i-1')).toMatchObject({ transaction_id: 'tx-1', paid_amount: 100, status: 'paid' })
    expect(db.rows.transactions.find(t => t.id === 'tx-1')!.deleted_at).toBeNull()
    expect(db.calls).toEqual([])
  })

  it('does not fall back to the step-by-step path on a real refusal', async () => {
    db.rpc.error = { message: 'new row violates row-level security policy', code: '42501' }
    await deleteTransactionSafely(makeClient(db), { transactionId: 'tx-1' })
    expect(db.calls).toEqual([])
  })

  it('falls back when the migration has not reached this database', async () => {
    db.rpc.missing = true
    const out = await deleteTransactionSafely(makeClient(db), { transactionId: 'tx-1', deletedBy: 'u-1' })
    expect(out.ok).toBe(true)
    expect(out.atomic).toBe(false)
    expect(db.calls.length).toBeGreaterThan(0)
  })
})

describe('deleteTransactionInSteps — the path for a database without the RPC', () => {
  let db: MockDb
  beforeEach(() => { db = freshDb(); seed(db) })

  it('a locked period leaves every link intact', async () => {
    lock(db, '2026-01-01')
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1', deletedBy: 'u-1' })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual([])
    expect(out.message).toContain('2026-01 is locked')
    expect(db.rows.invoice_transaction_links).toHaveLength(2)
    expect(db.rows.credit_installments.find(i => i.id === 'i-1')).toMatchObject({ transaction_id: 'tx-1', paid_amount: 100, status: 'paid' })
    expect(db.rows.transactions.find(t => t.id === 'tx-1')!.deleted_at).toBeNull()
    // Reads only. Nothing was written before the refusal.
    expect(db.calls.every(c => c.op === 'select')).toBe(true)
  })

  it('a locked period the pre-check misses still costs nothing, because the guarded write goes first', async () => {
    // The trigger refuses the soft delete; the pre-check saw an empty
    // `closed_periods` because the month was locked a moment ago.
    db.errors['transactions:update'] = { message: 'Period 2026-01 je zakljucan za ovu firmu', code: '23514' }
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1' })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual([])
    expect(out.message).toContain('nothing was lost')
    expect(db.rows.invoice_transaction_links).toHaveLength(2)
    expect(db.rows.credit_installments.find(i => i.id === 'i-1')!.status).toBe('paid')
    expect(db.calls.some(c => c.table === 'invoice_transaction_links')).toBe(false)
    expect(db.calls.some(c => c.table === 'credit_installments')).toBe(false)
  })

  it('removes exactly the invoice links and instalments of that transaction and nothing else', async () => {
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1', deletedBy: 'u-1' })

    expect(out.ok).toBe(true)
    expect(out.done).toEqual(['transaction', 'invoiceLinks', 'installments'])

    expect(db.rows.transactions.find(t => t.id === 'tx-1')!.deleted_at).toBeTruthy()
    expect(db.rows.transactions.find(t => t.id === 'tx-1')!.deleted_by).toBe('u-1')
    expect(db.rows.transactions.find(t => t.id === 'tx-2')!.deleted_at).toBeNull()

    expect(db.rows.invoice_transaction_links.map(l => l.id)).toEqual(['l-2'])

    expect(db.rows.credit_installments.find(i => i.id === 'i-1')).toMatchObject({
      transaction_id: null, paid_amount: 0, status: 'outstanding', paid_date: null,
    })
    expect(db.rows.credit_installments.find(i => i.id === 'i-2')).toMatchObject({
      transaction_id: 'tx-2', paid_amount: 200, status: 'paid',
    })
  })

  it('writes in the order that makes a refusal free', async () => {
    await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1' })
    const writes = db.calls.filter(c => c.op !== 'select').map(c => c.table)
    expect(writes).toEqual(['transactions', 'invoice_transaction_links', 'credit_installments'])
  })

  it('refuses a transaction that is not there rather than deleting links for it', async () => {
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-missing' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('may already have been deleted')
    expect(db.rows.invoice_transaction_links).toHaveLength(2)
  })

  it('catches a soft delete that reported success and changed nothing', async () => {
    // PostgREST answers a zero-row update with 200. The row is still visible
    // afterwards, and that — not the response — is what gives it away.
    db.rows.transactions = db.rows.transactions.map(t => t.id === 'tx-1' ? { ...t, id: 'tx-1', __frozen: true } : t)
    const client = makeClient(db)
    const original = client.from
    ;(client as any).from = (table: string) => {
      const b = original(table)
      if (table !== 'transactions') return b
      return new Proxy({}, {
        get(_t, prop: string) {
          // An update that matches nothing: accepted, no rows changed.
          if (prop === 'update') return () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          })
          return (b as any)[prop]
        },
      })
    }
    const out = await deleteTransactionInSteps(client, { transactionId: 'tx-1' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain('still there')
    expect(db.rows.invoice_transaction_links).toHaveLength(2)
  })

  it('reports precisely what was and was not done when the link removal fails', async () => {
    db.errors['invoice_transaction_links:delete'] = { message: 'connection reset' }
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1' })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual(['transaction'])
    expect(out.message).toContain('The transaction was deleted')
    expect(out.message).toContain('connection reset')
    // The instalments were never reached, which is what the message says.
    expect(db.rows.credit_installments.find(i => i.id === 'i-1')!.status).toBe('paid')
  })

  it('reports precisely what was and was not done when the instalment reset fails', async () => {
    db.errors['credit_installments:update'] = { message: 'connection reset' }
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1' })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual(['transaction', 'invoiceLinks'])
    expect(out.message).toContain('invoice allocations removed')
    expect(out.message).toContain('Bank Credits')
  })

  it('proceeds when the period-lock pre-check cannot be read at all', async () => {
    db.errors['feature_flags:select'] = { message: 'permission denied' }
    const out = await deleteTransactionInSteps(makeClient(db), { transactionId: 'tx-1' })
    expect(out.ok).toBe(true)
  })
})

// ─── Reallocating an invoice's link ──────────────────────────────────────────

describe('reallocateInvoiceLink', () => {
  let db: MockDb
  beforeEach(() => {
    db = freshDb()
    db.rows.invoice_transaction_links = [
      { id: 'l-old', invoice_id: 'inv-1', transaction_id: 'tx-old', allocated_amount: 50, allocated_amount_usd: 50 },
      { id: 'l-other', invoice_id: 'inv-2', transaction_id: 'tx-other', allocated_amount: 70, allocated_amount_usd: 70 },
    ]
  })

  it('a failed link insert leaves the previous allocation in place', async () => {
    db.errors['invoice_transaction_links:upsert'] = { message: 'Period 2026-01 je zakljucan za ovu firmu' }
    const out = await reallocateInvoiceLink(makeClient(db), {
      invoiceId: 'inv-1', transactionId: 'tx-new', allocatedAmount: 100, allocatedAmountUsd: 100,
    })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual([])
    expect(out.message).toContain('Nothing was removed')
    // The allocation that existed a moment ago is still there.
    expect(db.rows.invoice_transaction_links.map(l => l.id)).toEqual(['l-old', 'l-other'])
    // And no delete was even attempted.
    expect(db.calls.some(c => c.op === 'delete')).toBe(false)
  })

  it('replaces the allocation and leaves other invoices alone', async () => {
    const out = await reallocateInvoiceLink(makeClient(db), {
      invoiceId: 'inv-1', transactionId: 'tx-new', allocatedAmount: 100, allocatedAmountUsd: 100, note: 'Reconciled',
    })

    expect(out.ok).toBe(true)
    const links = db.rows.invoice_transaction_links
    expect(links.filter(l => l.invoice_id === 'inv-1')).toHaveLength(1)
    expect(links.find(l => l.invoice_id === 'inv-1')).toMatchObject({ transaction_id: 'tx-new', allocated_amount: 100, note: 'Reconciled' })
    expect(links.find(l => l.id === 'l-other')).toBeTruthy()
  })

  it('writes the replacement before removing anything', async () => {
    await reallocateInvoiceLink(makeClient(db), {
      invoiceId: 'inv-1', transactionId: 'tx-new', allocatedAmount: 100, allocatedAmountUsd: 100,
    })
    expect(db.calls.map(c => c.op)).toEqual(['upsert', 'delete'])
  })

  it('re-saving an unchanged link is an update, not a delete and a re-insert', async () => {
    db.rows.invoice_transaction_links = [
      { id: 'l-1', invoice_id: 'inv-1', transaction_id: 'tx-1', allocated_amount: 50, allocated_amount_usd: 50 },
    ]
    const out = await reallocateInvoiceLink(makeClient(db), {
      invoiceId: 'inv-1', transactionId: 'tx-1', allocatedAmount: 120, allocatedAmountUsd: 120,
    })
    expect(out.ok).toBe(true)
    expect(db.rows.invoice_transaction_links).toHaveLength(1)
    expect(db.rows.invoice_transaction_links[0]).toMatchObject({ id: 'l-1', allocated_amount: 120 })
  })

  it('warns that the invoice now counts both when the cleanup fails', async () => {
    db.errors['invoice_transaction_links:delete'] = { message: 'connection reset' }
    const out = await reallocateInvoiceLink(makeClient(db), {
      invoiceId: 'inv-1', transactionId: 'tx-new', allocatedAmount: 100, allocatedAmountUsd: 100,
    })

    expect(out.ok).toBe(false)
    expect(out.done).toEqual(['insertReplacement'])
    expect(out.message).toContain('counts both')
    // More than they started with — never less.
    expect(db.rows.invoice_transaction_links.filter(l => l.invoice_id === 'inv-1')).toHaveLength(2)
  })
})

describe('reportPostFailure', () => {
  it('says nothing was written when the first step fails, so nobody hunts for damage', () => {
    const msg = reportPostFailure('Payroll', 'the payroll record', 'Period 2026-01 is locked', [])
    expect(msg).toContain('Nothing was written')
    expect(msg).toContain('retrying is safe')
  })

  it('names what already landed, so a retry does not double it', () => {
    const msg = reportPostFailure('Payroll', 'net salary invoices', 'permission denied', [
      { label: 'the payroll record' },
      { label: 'payroll lines', count: 13 },
    ])
    expect(msg).toContain('the payroll record')
    expect(msg).toContain('13 payroll lines')
    expect(msg).toContain('duplicated')
  })

  it('carries the database message through rather than replacing it', () => {
    const msg = reportPostFailure('Payroll', 'the tax invoice', 'Period 2026-01 is locked', [])
    expect(msg).toContain('Period 2026-01 is locked')
  })

  it('names the step that failed', () => {
    expect(reportPostFailure('Payroll', 'the tax invoice', 'x', []))
      .toContain('failed writing the tax invoice')
  })

  it('counts only where a count was given', () => {
    const msg = reportPostFailure('An invoice', 'the link', 'x', [
      { label: 'the invoice' }, { label: 'child invoices', count: 4 },
    ])
    expect(msg).toContain('Already written: the invoice, 4 child invoices.')
  })
})

describe('softDeleteRow', () => {
  const stub = (answer: { data?: unknown; error?: { message: string } | null }) => {
    const calls: any[] = []
    return {
      client: {
        from: () => { throw new Error('a soft delete must not touch the table directly') },
        rpc: (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args })
          return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
        },
      } as unknown as SupabaseLike,
      calls,
    }
  }

  it('goes through the database function, never the table', async () => {
    const { client, calls } = stub({ data: true })
    const r = await softDeleteRow(client, 'transactions', 'tx-1', 'user-1')
    expect(r.ok).toBe(true)
    expect(calls).toEqual([{
      fn: 'soft_delete_row',
      args: { p_table: 'transactions', p_id: 'tx-1', p_deleted_by: 'user-1' },
    }])
  })

  it('carries the refusal through rather than swallowing it', async () => {
    const { client } = stub({ error: { message: 'Period 2026-01 is locked' } })
    const r = await softDeleteRow(client, 'invoices', 'inv-1')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Period 2026-01 is locked')
  })

  it('does not report a delete that deleted nothing', async () => {
    // The function answers false when the row was already gone.
    const { client } = stub({ data: false })
    const r = await softDeleteRow(client, 'passthrough', 'pt-1')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('already deleted')
  })

  it('passes a null author rather than omitting it', async () => {
    const { client, calls } = stub({ data: true })
    await softDeleteRow(client, 'transactions', 'tx-1')
    expect(calls[0].args.p_deleted_by).toBeNull()
  })
})

describe('runWrite', () => {
  const answer = (error: { message: string } | null) =>
    Promise.resolve({ error }) as PromiseLike<{ error: any }>

  it('reports a clean write', async () => {
    expect(await runWrite('Rename category', answer(null))).toEqual({ ok: true, message: '' })
  })

  it('puts what the user was doing in front of the database message', async () => {
    const r = await runWrite('Rename category', answer({ message: 'permission denied' }))
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Rename category failed: permission denied')
  })

  it('carries the message through rather than replacing it', async () => {
    const r = await runWrite('Delete department', answer({ message: 'Period 2026-01 is locked' }))
    expect(r.message).toContain('Period 2026-01 is locked')
  })
})
