// ─── Hal E-Bank payment orders, TKDIS text format ───────────────────────────
//
// The layout is Halcom's "Domaći platni promet — format uvozno/izvoznih
// datoteka" (Hal E-Bank 23.x.x.20, Halcom a.d. Beograd, 2024):
//
//   address row   (optional)  payer account, name, city, date, "MULTI E-BANK", "0"
//   summary row   (mandatory with the address row)  payer, total, count, "9"
//   one row per order          beneficiary, purpose, code, amount, reference, "1"
//
// THE PAYER IS ONLY IN THE FIRST TWO ROWS. An order row has no payer account:
// Hal E-Bank books every imported order to the account selected before the
// import ("1 Izaberite račun sa kog plaćate … 4 (U/Iz)voz > Uvoz"). A file
// therefore carries ONE payer, and a selection paid from several banks is
// several files. Whether Hal E-Bank compares the address row with the selected
// account depends on its converter setting ("Parametri konvertora" — whether
// the summary and address data are taken into account); the file always
// carries both rows, correct, so that check has something to compare.

export interface TkdisPayer {
  account_number: string
  name: string
  city: string
}

export interface TkdisOrder {
  beneficiaryAccount: string
  beneficiaryName: string
  beneficiaryAddress: string
  beneficiaryCity: string
  /** Purpose of payment (svrha), up to 36 characters. */
  purpose: string
  /** Three digits: the form of payment and the two-digit code, e.g. "221". */
  paymentCode: string
  /** In dinars. Written in paras, so it must already be rounded to 2 places. */
  amount: number
  /** Model of the credit reference ("97", "00" or empty). */
  creditModel: string
  creditReference: string
}

export const HALCOM_SIFRE = [
  { value: '221', label: '221 – Promet robe i usluga (međufazna potrošnja)' },
  { value: '220', label: '220 – Promet robe i usluga (finalna potrošnja)' },
  { value: '223', label: '223 – Investicije u objekte i opremu' },
  { value: '231', label: '231 – Carine i druge uvozne dažbine' },
  { value: '240', label: '240 – Zarade' },
  { value: '253', label: '253 – Javni prihodi (osim poreza i doprinosa)' },
  { value: '254', label: '254 – Porezi i doprinosi (objedinjena naplata)' },
  { value: '260', label: '260 – Premije osiguranja' },
  { value: '263', label: '263 – Ostali transferi' },
  { value: '270', label: '270 – Kratkoročni krediti' },
  { value: '271', label: '271 – Dugoročni krediti' },
]

export const DEFAULT_SIFRA = '221'

/**
 * Plain ASCII, upper case. The file is written one byte per character, and a
 * Serbian letter would not survive that: `č` is U+010D, whose low byte is
 * 0x0D — a carriage return in the middle of an order row.
 */
export function asciiUpper(s: string | null | undefined): string {
  return (s || '')
    .replace(/[đĐ]/g, 'DJ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, ' ')
}

const padR = (s: string, n: number): string => asciiUpper(s).substring(0, n).padEnd(n, ' ')

/** An account as Halcom wants it: exactly 18 digits, bank + party + control. */
export function cleanAccount(acc: string | null | undefined): string {
  const raw = (acc || '').replace(/\s/g, '')
  const digits = raw.replace(/[^0-9]/g, '')
  const parts = raw.split('-').filter(p => p.length > 0)
  if (parts.length === 3) {
    const bank = parts[0].padStart(3, '0').slice(-3)
    const ctrl = parts[2].padStart(2, '0').slice(-2)
    const core = parts[1].padStart(13, '0').slice(-13)
    return bank + core + ctrl
  }
  if (parts.length === 2) {
    return parts[0].padStart(3, '0').slice(-3) + parts[1].padStart(15, '0').slice(-15)
  }
  if (digits.length >= 18) return digits.slice(-18)
  if (digits.length > 5) {
    return digits.slice(0, 3) + digits.slice(3, -2).padStart(13, '0').slice(-13) + digits.slice(-2)
  }
  return digits
}

export function ddmmyy(date: Date): string {
  return String(date.getDate()).padStart(2, '0')
    + String(date.getMonth() + 1).padStart(2, '0')
    + String(date.getFullYear()).slice(-2)
}

const paras = (amount: number): number => Math.round(amount * 100)

/** The file's text, rows joined by CRLF and ended by the DOS end-of-file byte. */
export function buildTkdis(payer: TkdisPayer, orders: TkdisOrder[], date: Date): string {
  const payerAcc = cleanAccount(payer.account_number)
  const datum = ddmmyy(date)
  const total = orders.reduce((s, o) => s + paras(o.amount), 0)

  const head = padR(payerAcc, 18) + padR(payer.name, 35) + padR(payer.city, 10)
  const rows: string[] = []
  // Address row: 1–63 payer, 64–69 date, 70–167 blank, 168–179 MULTI E-BANK, 180 "0".
  rows.push(head + datum + ' '.repeat(98) + 'MULTI E-BANK0')
  // Summary row: 64–78 total, 79–83 count, 84–179 blank, 180 "9".
  rows.push(head + String(total).padStart(15, '0') + String(orders.length).padStart(5, '0') + ' '.repeat(96) + '9')

  for (const o of orders) {
    rows.push(
      padR(cleanAccount(o.beneficiaryAccount), 18)   // 1–18
      + padR(o.beneficiaryName, 35)                    // 19–53
      + padR(o.beneficiaryAddress, 35)                 // 54–88
      + padR(o.beneficiaryCity, 10)                    // 89–98
      + '0'                                            // 99
      + ' '.repeat(2)                                  // 100–101 debit model
      + ' '.repeat(23)                                 // 102–124 debit reference
      + padR(o.purpose, 36)                            // 125–160
      + '00000'                                        // 161–165
      + ' '                                            // 166
      + padR(o.paymentCode, 3)                         // 167 form, 168–169 code
      + ' '                                            // 170
      + ' '                                            // 171
      + String(paras(o.amount)).padStart(13, '0')      // 172–184
      + padR(o.creditModel, 2)                         // 185–186
      + padR(o.creditReference, 23)                    // 187–209
      + datum                                          // 210–215
      + '0'                                            // 216 payment order
      + '1'                                            // 217 order record
      + '0',                                           // 218 not instant
    )
  }
  return rows.join('\r\n') + '\r\n\x1a'
}

/** The file's bytes: one per character, which is safe because the text is ASCII. */
export function tkdisBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/**
 * Names the bank and the end of the payer account, so a file is not imported
 * under the wrong account by mistake: nalozi_INTESA_xxxx4521_191026.txt
 */
export function tkdisFileName(bankName: string | null | undefined, payerAccount: string, date: Date): string {
  const bank = asciiUpper(bankName || 'BANKA').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'BANKA'
  const acc = cleanAccount(payerAccount)
  return `nalozi_${bank}_${acc.slice(-6)}_${ddmmyy(date)}.txt`
}
