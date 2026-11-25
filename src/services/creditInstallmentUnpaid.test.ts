import {
  canReturnToUnpaid, unpaidQuestion, markInstallmentUnpaid, unpaidDone, UNPAID_LEAVES_LEGS, PAID_BY_A_LINE,
  PAID_BY_A_MANUAL_ENTRY, PAID_BY_A_TRANSACTION, payingLineOf,
} from './creditInstallmentUnpaid'

// Invented credit and figures.

const inst = (over: Record<string, unknown> = {}) => ({
  installment_no: 5, due_date: '2026-10-31', status: 'paid', paid_amount: 1250, total_amount: 1250, ...over,
}) as any
const credit = (over: Record<string, unknown> = {}) => ({ name: 'Obrtni kredit', status: 'active', currency: 'EUR', ...over })

describe('which instalment can go back to unpaid', () => {
  it('a paid one and a partly paid one, never an unpaid one', () => {
    expect(canReturnToUnpaid({ status: 'paid', paid_amount: 1250 })).toBe(true)
    // Marked paid with nothing recorded as paid (older rows): still paid.
    expect(canReturnToUnpaid({ status: 'paid', paid_amount: 0 })).toBe(true)
    expect(canReturnToUnpaid({ status: 'outstanding', paid_amount: 600 })).toBe(true)
    expect(canReturnToUnpaid({ status: 'outstanding', paid_amount: 0 })).toBe(false)
    expect(canReturnToUnpaid({ status: 'outstanding', paid_amount: null })).toBe(false)
  })
})

describe('the question', () => {
  it('says plainly what moves, and that the posted rows stay', () => {
    expect(unpaidQuestion(inst(), credit(), 0)).toBe([
      'Vratiti ratu #5 (dospeće 31.10.2026.) kredita „Obrtni kredit“ na neplaćenu?',
      '',
      '· rata postaje neplaćena: plaćeno 0, bez datuma plaćanja i bez veze sa stavkom izvoda (sada plaćeno 1.250,00 EUR od 1.250,00 EUR)',
      '',
      'Redovi glavnice i kamate koji su za ovu ratu već proknjiženi OSTAJU u P&L-u: ovo ih ne briše. '
        + 'Ako su pogrešni, obrišite ih posebno na strani Transakcije — inače će otplata, kada se rata ponovo plati, '
        + 'biti proknjižena dvaput.',
    ].join('\n'))
  })

  it('says a closed credit opens again, and that a linked SEF invoice stays linked', () => {
    const q = unpaidQuestion(inst({ paid_amount: 600, status: 'outstanding' }), credit({ status: 'closed' }), 1)
    expect(q).toContain('(sada plaćeno 600,00 EUR od 1.250,00 EUR)')
    expect(q).toContain('\n· kredit je zatvoren, pa se ponovo otvara\n')
    expect(q).toContain('\n· SEF faktura kamate vezana za ovu ratu ostaje vezana\n')
    expect(unpaidQuestion(inst(), credit(), 2)).toContain('· SEF fakture kamate vezane za ovu ratu (2) ostaju vezane')
    expect(q.endsWith(UNPAID_LEAVES_LEGS)).toBe(true)
  })

  it('when a statement line paid it, says deleting the statement also takes the rows', () => {
    const q = unpaidQuestion(inst({ transaction_id: 'tx-1' }), credit(), 0, 'statement')
    expect(q.split('\n')[3]).toBe(PAID_BY_A_LINE)
    expect(PAID_BY_A_LINE).toBe(
      '· ratu je platila stavka izvoda koja je i dalje u knjigama. Ako je ta uplata pogrešna, obrišite izvod '
      + 'kojem pripada („Obriši izvod“): to u jednom koraku vraća ratu na neplaćenu i uklanja njene redove glavnice '
      + 'i kamate (kod izvoda proknjiženih pre nego što je izvod pamtio te redove, njih ručno). Brisanje same '
      + 'stavke na strani Transakcije vraća ratu, ali te redove ostavlja. Ovo dugme ne uklanja ni stavku ni te redove.')
  })

  it('when a transaction entered by hand paid it, says its delete returns the instalment and the rows go by hand', () => {
    const q = unpaidQuestion(inst({ transaction_id: 'tx-1' }), credit(), 0, 'manual')
    expect(q.split('\n')[3]).toBe(PAID_BY_A_MANUAL_ENTRY)
    expect(PAID_BY_A_MANUAL_ENTRY).toBe(
      '· ratu je platila ručno uneta transakcija, ne izvod. Brisanje te transakcije na strani Transakcije vraća '
      + 'ratu na neplaćenu, a redove glavnice i kamate obrišite ručno. Ovo dugme ne uklanja ni transakciju ni te redove.')
    expect(q).not.toMatch(/izvod kojem/)
  })

  it('when what paid it cannot be read, names neither way', () => {
    const q = unpaidQuestion(inst({ transaction_id: 'tx-1' }), credit(), 0, 'unknown')
    expect(q.split('\n')[3]).toBe(PAID_BY_A_TRANSACTION)
    expect(PAID_BY_A_TRANSACTION).not.toMatch(/izvod|ručno uneta/)
    // The default, too.
    expect(unpaidQuestion(inst({ transaction_id: 'tx-1' }), credit(), 0)).toContain(PAID_BY_A_TRANSACTION)
  })

  it('says nothing of a paying line when none is stamped', () => {
    const q = unpaidQuestion(inst({ transaction_id: null }), credit(), 0, 'statement')
    for (const s of [PAID_BY_A_LINE, PAID_BY_A_MANUAL_ENTRY, PAID_BY_A_TRANSACTION]) expect(q).not.toContain(s)
  })

  it('reads the paying line by its batch, and calls any failure unknown', async () => {
    const client = (answer: any, fail = false) => {
      const calls: any[] = []
      const q: any = {
        select: (c: string) => { calls.push(['select', c]); return q },
        eq: (c: string, v: any) => { calls.push(['eq', c, v]); return q },
        maybeSingle: () => (fail ? Promise.reject(new Error('mreža')) : Promise.resolve(answer)),
      }
      return { client: { from: (t: string) => { calls.push(['from', t]); return q } }, calls }
    }
    const a = client({ data: { import_batch_id: 'b-1' }, error: null })
    expect(await payingLineOf(a.client, 'tx-1')).toBe('statement')
    expect(a.calls).toEqual([['from', 'transactions'], ['select', 'import_batch_id'], ['eq', 'id', 'tx-1']])
    expect(await payingLineOf(client({ data: { import_batch_id: null }, error: null }).client, 'tx-1')).toBe('manual')
    expect(await payingLineOf(client({ data: null, error: null }).client, 'tx-1')).toBe('unknown')
    expect(await payingLineOf(client({ data: null, error: { message: 'x' } }).client, 'tx-1')).toBe('unknown')
    expect(await payingLineOf(client(null, true).client, 'tx-1')).toBe('unknown')
  })

  it('names no count of the posted rows, which cannot be found reliably', () => {
    expect(UNPAID_LEAVES_LEGS).not.toMatch(/\d/)
  })
})

describe('the call', () => {
  it('asks the one function, with the instalment alone', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { credit_reopened: true, sef_links: 1 }, error: null })
    expect(await markInstallmentUnpaid({ rpc }, 'i-5')).toEqual({ creditReopened: true, sefLinks: 1 })
    expect(rpc).toHaveBeenCalledWith('credit_installment_mark_unpaid', { p_id: 'i-5' })
  })

  it('throws the function\'s own sentence', async () => {
    const said = 'Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.'
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: said } })
    await expect(markInstallmentUnpaid({ rpc }, 'i-5')).rejects.toThrow(said)
  })

  it('says what was done', () => {
    expect(unpaidDone(5, { creditReopened: false, sefLinks: 0 }))
      .toBe('Rata #5 je vraćena na neplaćenu. Redovi glavnice i kamate u P&L-u nisu dirani.')
    expect(unpaidDone(5, { creditReopened: true, sefLinks: 1 }))
      .toBe('Rata #5 je vraćena na neplaćenu. Kredit je ponovo otvoren. SEF faktura kamate ostaje vezana za nju. Redovi glavnice i kamate u P&L-u nisu dirani.')
  })
})
