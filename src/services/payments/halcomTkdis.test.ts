import { buildTkdis, cleanAccount, asciiUpper, tkdisFileName, tkdisBytes, type TkdisOrder } from './halcomTkdis'

const payer = { account_number: '160-0000000123456-78', name: 'Milinković Company doo', city: 'Beograd' }
const order = (over: Partial<TkdisOrder> = {}): TkdisOrder => ({
  beneficiaryAccount: '205-0000000654321-11', beneficiaryName: 'Beton Plus d.o.o.', beneficiaryAddress: 'Šumadijska 5',
  beneficiaryCity: 'Čačak', purpose: 'UPLATA PO FAKTURI 12/2026', paymentCode: '221', amount: 1234.56,
  creditModel: '97', creditReference: '12-2026', ...over,
})
const date = new Date(2026, 9, 19)
const rows = (text: string) => text.split('\r\n').filter(r => r && r !== '\x1a')

describe('the Halcom TKDIS file', () => {
  it('has an address row, a summary row and one row per order, at the documented lengths', () => {
    const r = rows(buildTkdis(payer, [order(), order()], date))
    expect(r).toHaveLength(4)
    expect(r[0]).toHaveLength(180)
    expect(r[1]).toHaveLength(180)
    expect(r[2]).toHaveLength(218)
    expect(r[0].slice(167, 180)).toBe('MULTI E-BANK0')
    expect(r[1].slice(179)).toBe('9')
    expect(r[2].slice(216, 218)).toBe('10')
  })

  it('names the payer account in both header rows', () => {
    const r = rows(buildTkdis(payer, [order()], date))
    expect(r[0].slice(0, 18)).toBe('160000000012345678')
    expect(r[1].slice(0, 18)).toBe('160000000012345678')
  })

  it('writes the order count in five digits, also for ten or more orders', () => {
    const r = rows(buildTkdis(payer, Array.from({ length: 12 }, () => order({ amount: 1 })), date))
    expect(r[1]).toHaveLength(180)
    expect(r[1].slice(63, 78)).toBe('000000000001200')
    expect(r[1].slice(78, 83)).toBe('00012')
  })

  it('puts code, amount, model and reference where Halcom reads them', () => {
    const r = rows(buildTkdis(payer, [order({ paymentCode: '254', amount: 99.9 })], date))[2]
    expect(r.slice(166, 169)).toBe('254')
    expect(r.slice(171, 184)).toBe('0000000009990')
    expect(r.slice(184, 186)).toBe('97')
    expect(r.slice(186, 209).trim()).toBe('12-2026')
    expect(r.slice(209, 215)).toBe('191026')
  })

  it('keeps every byte ASCII: a Serbian letter never becomes a line break', () => {
    const text = buildTkdis(payer, [order()], date)
    expect(text).toContain('CACAK')
    expect(text).toContain('SUMADIJSKA')
    expect(text).toContain('MILINKOVIC')
    expect(Array.from(tkdisBytes(text)).filter(b => b === 0x0d)).toHaveLength(3)
    expect(asciiUpper('Đurđevdan čćšž')).toBe('DJURDJEVDAN CCSZ')
  })

  it('normalises accounts to 18 digits', () => {
    expect(cleanAccount('160-123456-78')).toBe('160000000012345678')
    expect(cleanAccount('160-000000000123456')).toBe('160000000000123456')
    expect(cleanAccount('160000000012345678')).toBe('160000000012345678')
  })

  it('names the file after the bank and the end of the payer account', () => {
    expect(tkdisFileName('Banca Intesa', payer.account_number, date)).toBe('nalozi_BANCA_INTESA_345678_191026.txt')
  })
})
