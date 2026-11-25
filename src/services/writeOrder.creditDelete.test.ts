import { deleteConfirmText, confirmDeleteText, type SupabaseLike } from './writeOrder'

// ── The question before one transaction is deleted ─────────────────────────
//
// Since 20261125090000 a statement stamps the instalment it paid with the
// bank line, so deleting that line alone reopens the instalment, while the
// principal and interest legs it posted stay in the P&L. The question says so,
// in Serbian that agrees with how many instalments and legs there are.

const bankLine = { id: 't-line', type: 'credit_payment', pl_impact: false }
const leg = { id: 't-leg', type: 'credit_payment', pl_impact: true }
const expense = { id: 't-x', type: 'direct', pl_impact: true }

describe('deleteConfirmText', () => {
  it('one instalment, two legs', () => {
    expect(deleteConfirmText(bankLine, 1, 2)).toBe([
      'Obrisati ovu transakciju?',
      '',
      'To je stavka izvoda kojom je plaćen kredit; platila je 1 ratu kredita.',
      'Brisanje ponovo otvara ratu, ali redovi glavnice i kamate koje je proknjižila (2 reda) ostaju u P&L-u. '
        + 'Obrišite i te redove, ili umesto toga obrišite ceo izvod — inače će rata biti proknjižena '
        + 'dvaput kada se ponovo plati.',
    ].join('\n'))
  })

  it('an interest-only instalment: one leg', () => {
    expect(deleteConfirmText(bankLine, 1, 1).split('\n')[3]).toBe(
      'Brisanje ponovo otvara ratu, ali red glavnice ili kamate koji je proknjižila ostaje u P&L-u. '
      + 'Obrišite i taj red, ili umesto toga obrišite ceo izvod — inače će rata biti proknjižena '
      + 'dvaput kada se ponovo plati.')
  })

  it('three instalments, five legs', () => {
    const t = deleteConfirmText(bankLine, 3, 5)
    expect(t).toContain('platila je 3 rate kredita.')
    expect(t).toContain('Brisanje ponovo otvara te rate, ali redovi glavnice i kamate koje je proknjižila (5 redova) ostaju u P&L-u.')
    expect(t).toContain('inače će rate biti proknjižene dvaput kada se ponovo plate.')
  })

  it('five instalments read "5 rata kredita"', () => {
    expect(deleteConfirmText(bankLine, 5, 10)).toContain('platila je 5 rata kredita.')
  })

  it('legs that cannot be counted are named without a number', () => {
    expect(deleteConfirmText(bankLine, 1, null)).toContain(
      'ali redovi glavnice i kamate koje je proknjižila ostaju u P&L-u. Obrišite i njih,')
  })

  it('no legs left: only the reopening is said', () => {
    expect(deleteConfirmText(bankLine, 1, 0).split('\n')[3]).toBe('Brisanje ponovo otvara ratu.')
  })

  it('warns anyway when the instalment count could not be read', () => {
    expect(deleteConfirmText(bankLine, null, 2))
      .toContain('To je stavka izvoda kojom je plaćen kredit i možda je platila ratu kredita.')
  })

  it('asks the plain question for a leg, an ordinary row, and a bank line that settled nothing', () => {
    expect(deleteConfirmText(leg, 1, 2)).toBe('Obrisati ovu transakciju?')
    expect(deleteConfirmText(expense, 1, 2)).toBe('Obrisati ovu transakciju?')
    expect(deleteConfirmText(bankLine, 0, 2)).toBe('Obrisati ovu transakciju?')
  })
})

// ── Asking the database ─────────────────────────────────────────────────────

interface Answers {
  instalments: { count: number | null; error: any } | 'throws'
  line?: { data: any; error: any }
  family?: { data: any; error: any }
}

/** A client that answers the three reads and records every filter. */
const fake = (a: Answers) => {
  const asked: string[] = []
  const client: SupabaseLike = {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const filters: string[] = []
      const c: any = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => { filters.push(`${col}=${v}`); return c }
      c.is = (col: string, v: unknown) => { filters.push(`${col} is ${v}`); return c }
      c.single = () => { asked.push(`${table} one ${filters.join(',')}`); return Promise.resolve(a.line ?? { data: null, error: null }) }
      c.then = (ok: any, bad: any) => {
        asked.push(`${table} ${filters.join(',')}`)
        if (table === 'credit_installments') {
          return a.instalments === 'throws'
            ? Promise.reject(new Error('Failed to fetch')).then(ok, bad)
            : Promise.resolve(a.instalments).then(ok, bad)
        }
        return Promise.resolve(a.family ?? { data: [], error: null }).then(ok, bad)
      }
      return c
    },
  }
  return { client, asked }
}

const LINE = { import_batch_id: 'b-1', transaction_date: '2026-10-13', bank_id: 'bank-1', partner_id: null }

describe('confirmDeleteText', () => {
  it('counts the instalments and the legs beside the bank line', async () => {
    const { client, asked } = fake({
      instalments: { count: 1, error: null },
      line: { data: LINE, error: null },
      family: { data: [{ id: 't-line', pl_impact: false }, { id: 'p', pl_impact: true }, { id: 'i', pl_impact: true }], error: null },
    })
    const t = await confirmDeleteText(client, bankLine)
    expect(t).toContain('platila je 1 ratu kredita.')
    expect(t).toContain('(2 reda) ostaju u P&L-u')
    expect(asked).toEqual([
      'credit_installments transaction_id=t-line',
      'transactions one id=t-line',
      'transactions import_batch_id=b-1,transaction_date=2026-10-13,type=credit_payment,deleted_at is null,bank_id=bank-1,partner_id is null',
    ])
  })

  it('leaves the number out when two bank lines share the batch, day, bank and partner', async () => {
    const { client } = fake({
      instalments: { count: 1, error: null },
      line: { data: LINE, error: null },
      family: { data: [{ pl_impact: false }, { pl_impact: false }, { pl_impact: true }, { pl_impact: true }], error: null },
    })
    expect(await confirmDeleteText(client, bankLine)).toContain('Obrišite i njih,')
  })

  it('leaves the number out for a line with no batch', async () => {
    const { client } = fake({ instalments: { count: 1, error: null }, line: { data: { ...LINE, import_batch_id: null }, error: null } })
    expect(await confirmDeleteText(client, bankLine)).toContain('Obrišite i njih,')
  })

  it('does not ask anything for any other row, nor for legs when nothing was settled', async () => {
    const other = fake({ instalments: { count: 2, error: null } })
    expect(await confirmDeleteText(other.client, leg)).toBe('Obrisati ovu transakciju?')
    expect(await confirmDeleteText(other.client, expense)).toBe('Obrisati ovu transakciju?')
    expect(other.asked).toEqual([])
    const none = fake({ instalments: { count: 0, error: null } })
    expect(await confirmDeleteText(none.client, bankLine)).toBe('Obrisati ovu transakciju?')
    expect(none.asked).toEqual(['credit_installments transaction_id=t-line'])
  })

  it('warns when the instalment read fails or throws', async () => {
    expect(await confirmDeleteText(fake({ instalments: { count: null, error: { message: 'x' } } }).client, bankLine))
      .toContain('možda je platila ratu kredita')
    expect(await confirmDeleteText(fake({ instalments: 'throws' }).client, bankLine))
      .toContain('možda je platila ratu kredita')
  })
})
