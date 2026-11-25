import { deleteConfirmText, confirmDeleteText, type SupabaseLike } from './writeOrder'

// ── The question before one transaction is deleted ─────────────────────────
//
// Since 20261125090000 a statement stamps the instalment it paid with the
// bank line, so deleting that line alone reopens the instalment, while the
// principal and interest legs it posted stay in the P&L. The question says so.

const LEGS_STAY = 'Brisanje ponovo otvara ratu, ali redovi glavnice i kamate koje je proknjižila '
  + 'ostaju u P&L-u. Obrišite i ta dva reda, ili umesto toga obrišite ceo izvod — inače će rata '
  + 'biti proknjižena dvaput kada se ponovo plati.'

const bankLine = { id: 't-line', type: 'credit_payment', pl_impact: false }
const leg = { id: 't-leg', type: 'credit_payment', pl_impact: true }
const expense = { id: 't-x', type: 'direct', pl_impact: true }

/** A client whose instalment count answers `count`, or fails. */
const counting = (answer: { count: number | null; error: any } | 'throws') => {
  const asked: string[] = []
  const client: SupabaseLike = {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      asked.push(table)
      const c: any = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => { asked.push(`${col}=${v}`); return c }
      c.then = (ok: any, bad: any) => answer === 'throws'
        ? Promise.reject(new Error('Failed to fetch')).then(ok, bad)
        : Promise.resolve(answer).then(ok, bad)
      return c
    },
  }
  return { client, asked }
}

describe('deleteConfirmText', () => {
  it('names what a credit bank line that settled an instalment leaves behind', () => {
    expect(deleteConfirmText(bankLine, 1)).toBe([
      'Obrisati ovu transakciju?',
      '',
      'To je stavka izvoda kojom je plaćen kredit; zatvorila je rata kredita: 1.',
      LEGS_STAY,
    ].join('\n'))
  })

  it('warns anyway when the count could not be read', () => {
    const t = deleteConfirmText(bankLine, null)
    expect(t).toContain('To je stavka izvoda kojom je plaćen kredit i možda je zatvorila ratu kredita.')
    expect(t).toContain(LEGS_STAY)
  })

  it('asks the plain question for a leg, an ordinary row, and a bank line that settled nothing', () => {
    expect(deleteConfirmText(leg, 1)).toBe('Obrisati ovu transakciju?')
    expect(deleteConfirmText(expense, 1)).toBe('Obrisati ovu transakciju?')
    expect(deleteConfirmText(bankLine, 0)).toBe('Obrisati ovu transakciju?')
  })
})

describe('confirmDeleteText', () => {
  it('asks the database which instalments the bank line settled', async () => {
    const { client, asked } = counting({ count: 2, error: null })
    expect(await confirmDeleteText(client, bankLine)).toContain('zatvorila je rata kredita: 2.')
    expect(asked).toEqual(['credit_installments', 'transaction_id=t-line'])
  })

  it('does not ask for any other row', async () => {
    const { client, asked } = counting({ count: 2, error: null })
    expect(await confirmDeleteText(client, leg)).toBe('Obrisati ovu transakciju?')
    expect(await confirmDeleteText(client, expense)).toBe('Obrisati ovu transakciju?')
    expect(asked).toEqual([])
  })

  it('warns when the read fails or throws', async () => {
    expect(await confirmDeleteText(counting({ count: null, error: { message: 'x' } }).client, bankLine))
      .toContain('možda je zatvorila ratu kredita')
    expect(await confirmDeleteText(counting('throws').client, bankLine))
      .toContain('možda je zatvorila ratu kredita')
  })
})
