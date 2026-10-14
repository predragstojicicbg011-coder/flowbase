import fs from 'fs'
import path from 'path'
import { draftFromUbl, billAccount, reviewNotesFor } from './draftFromUbl'
import { parseUbl, type UblInvoice } from './ublInvoice'
import type { Proposal } from './proposeClassification'

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

const row = { id: 'r1', currency: 'RSD' }

const ubl = (over: Partial<UblInvoice> = {}): UblInvoice => ({
  invoiceNumber: '2026-0412', issueDate: '2026-09-30', dueDate: '2026-10-31',
  deliveryDate: null,
  currency: 'RSD', typeCode: '380', isCreditNote: false,
  supplierName: 'Telekom Srbija', supplierVatNumber: '100002887',
  supplierRegistrationNumber: '17162543',
  customerName: 'PRIMALAC DOO BEOGRAD', customerVatNumber: '100000001',
  customerRegistrationNumber: '20000001',
  bankAccount: '160-0000000000000-11', bankAccounts: ['160-0000000000000-11'],
  paymentReference: '12-345', paymentModel: '97',
  net: 10000, vat: 2000, total: 12000, sefPurchaseInvoiceId: null, lines: [], ...over,
})

const proposal: Proposal = {
  pl_category: 'Operating expenses', pl_subcategory: 'Utilities',
  department: 'Operations', dept_subcategory: 'Office',
  expense_description: 'Telephone', cf_type: 'recurring',
  reason: 'r', basis: 'history',
}

describe('the draft handed to the invoice dialog', () => {
  /** No `id`, so the dialog's prefill fills every field and `handleSave` takes
   *  the insert branch. An invoice is then created in exactly one place in
   *  this application. */
  /** The owner has several companies and the screen behind the dialog may be
   *  showing any of them. Which book a cost lands in comes off the bill. */
  it('carries the company the bill is addressed to', () => {
    expect(draftFromUbl(ubl(), row, 'p1', null, [], 'c1').company_id).toBe('c1')
  })

  it('carries no company where none was matched, rather than leaving the field out', () => {
    // Present and null, not absent: the dialog's prefill reads the key, and a
    // missing one would leave whatever company the screen behind it had.
    const d = draftFromUbl(ubl(), row, 'p1', null, [])
    expect(d.company_id).toBeNull()
    expect('company_id' in d).toBe(true)
  })

  /** The currency and the date the rate is read on both come off the
   *  document, so pressing Fetch asks the owner for an answer already
   *  determined — and leaving it blank converts the bill at 1. */
  it('carries the exchange rate it was given', () => {
    expect(draftFromUbl(ubl(), row, 'p1', null, [], 'c1', 0.0095).exchange_rate).toBe(0.0095)
  })

  it('carries a null rate where none could be fetched, leaving the Fetch button to it', () => {
    const d = draftFromUbl(ubl(), row, 'p1', null, [], 'c1')
    expect(d.exchange_rate).toBeNull()
    expect('exchange_rate' in d).toBe(true)
  })

  it('carries no id', () => {
    const d = draftFromUbl(ubl(), row, 'p1', null)
    expect(d.id).toBeUndefined()
    expect('id' in d).toBe(false)
  })

  /** The TRUE issue date, which is the whole reason the document is fetched —
   *  the headers do not carry one. */
  it('books under the issue date, not the sending date', () => {
    expect(draftFromUbl(ubl(), row, 'p1', null).invoice_date).toBe('2026-09-30')
  })

  /**
   * The account ON THIS BILL. `carriedAccountOf` reads `partner_id` and
   * `account_number` off the draft and keeps them, so the import inherits the
   * fix in `f633370` for free — and would inherit the bug too if either were
   * left off.
   */
  it('carries the supplier’s account from the bill', () => {
    const d = draftFromUbl(ubl(), row, 'p1', null)
    expect(d.partner_id).toBe('p1')
    expect(d.account_number).toBe('160-0000000000000-11')
  })

  it('carries the payment reference and its model', () => {
    const d = draftFromUbl(ubl(), row, 'p1', null)
    expect(d.reference_number).toBe('12-345')
    expect(d.model).toBe('97')
  })

  /** No account on the bill must reach the dialog as no account, never as the
   *  partner's primary. */
  it('leaves the account empty when the bill names none', () => {
    const d = draftFromUbl(ubl({ bankAccount: null, bankAccounts: [] }), row, 'p1', null,
      ['160-0000000000000-11'])
    expect(d.account_number).toBeNull()
  })

  /** An unknown supplier reaches the dialog with no partner rather than with
   *  somebody else's. */
  it('carries no partner where the PIB matched none', () => {
    expect(draftFromUbl(ubl(), row, null, null).partner_id).toBeNull()
  })

  it('applies the proposal when there is one', () => {
    const d = draftFromUbl(ubl(), row, 'p1', proposal)
    expect(d.pl_category).toBe('Operating expenses')
    expect(d.pl_subcategory).toBe('Utilities')
    expect(d.department).toBe('Operations')
    expect(d.dept_subcategory).toBe('Office')
    expect(d.expense_description).toBe('Telephone')
  })

  /** Read from the draft by the dialog. A proposal that dropped it would
   *  leave the cash-flow type to be set by hand on every bill. */
  it('carries the proposal’s cf_type', () => {
    expect(draftFromUbl(ubl(), row, 'p1', proposal).cf_type).toBe('recurring')
  })

  it('classifies nothing when there is no proposal', () => {
    const d = draftFromUbl(ubl(), row, 'p1', null)
    expect(d.pl_category).toBeNull()
    expect(d.cf_type).toBeNull()
  })

  it('falls back to the row’s currency when the document names none', () => {
    expect(draftFromUbl(ubl({ currency: null }), { id: 'r1', currency: 'EUR' }, 'p1', null).currency).toBe('EUR')
  })
})

describe('which account on the bill is booked', () => {
  const several = ['220-000003-64', '170-30000000003-11', '160-000003-49']

  /** Picking the first would be choosing where money goes by position in a
   *  string. The bill offers; the partner's saved accounts are what the owner
   *  has already vouched for, so a single match against those is a choice
   *  somebody made. */
  it('uses the one the partner already has saved, when exactly one matches', () => {
    expect(billAccount(several, ['170-30000000003-11'])).toEqual({
      account: '170-30000000003-11', offered: several,
    })
  })

  /** Compared on digits: dashes are typography. */
  it('matches a saved account written without the dashes', () => {
    expect(billAccount(several, ['16000000349']).account).toBe('160-000003-49')
  })

  it('chooses none when none of them is saved, and offers the list', () => {
    expect(billAccount(several, ['999-1-99'])).toEqual({ account: null, offered: several })
    expect(billAccount(several, [])).toEqual({ account: null, offered: several })
  })

  /** Two saved accounts both on the bill: still no way to tell which is meant,
   *  so the owner picks. */
  it('chooses none when more than one is saved', () => {
    expect(billAccount(several, ['220-000003-64', '160-000003-49']))
      .toEqual({ account: null, offered: several })
  })

  /** A bill that names one account has named it; nothing is being chosen by
   *  position. Offering nothing means no list is shown. */
  it('takes the single account a bill names, saved or not', () => {
    expect(billAccount(['160-1-11'], [])).toEqual({ account: '160-1-11', offered: [] })
    expect(billAccount(['160-1-11'], ['999-1-99'])).toEqual({ account: '160-1-11', offered: [] })
  })

  it('has nothing to choose where the bill names none', () => {
    expect(billAccount([], ['160-1-11'])).toEqual({ account: null, offered: [] })
  })
})

describe('the draft, against the real documents', () => {
  const inv2 = () => parseUbl(fixture('invoice-sample-2.xml'))
  const credit = () => parseUbl(fixture('credit-note-sample.xml'))

  /** KANCELARIJA offers three accounts in one field. With none saved the draft
   *  names none, rather than the first of the string. */
  it('leaves account_number empty when a bill offers several and none is saved', () => {
    const d = draftFromUbl(inv2(), row, 'p1', null, [])
    expect(d.account_number).toBeNull()
  })

  it('uses the saved one of the several, where one is saved', () => {
    expect(draftFromUbl(inv2(), row, 'p1', null, ['160000003-49']).account_number).toBe('160-000003-49')
  })

  /** The supplier sent a due date six days before the issue date. That is what
   *  the document says; correcting, swapping or dropping it would be this
   *  program deciding what the supplier meant. */
  it('carries a due date that precedes the issue date, unchanged', () => {
    const d = draftFromUbl(inv2(), row, 'p1', null)
    expect(d.due_date).toBe('2026-09-08')
  })

  /** The tax point, and so the rate, falls on the day the thing was supplied.
   *  invoice-sample-2.xml was supplied on the 8th and issued on the 14th; the
   *  queue's own date, when it was sent, is later still. Booked on the issue
   *  date, the cost lands in the wrong period and converts at another day's
   *  rate. */
  it('books on the date of supply, not the date the bill was written', () => {
    expect(inv2().deliveryDate).toBe('2026-09-08')
    expect(inv2().issueDate).toBe('2026-09-14')
    expect(draftFromUbl(inv2(), row, 'p1', null).invoice_date).toBe('2026-09-08')
  })

  it('falls back to the issue date where the bill names no supply date', () => {
    const noDelivery = ubl({ deliveryDate: null, issueDate: '2026-09-30' })
    expect(draftFromUbl(noDelivery, row, 'p1', null).invoice_date).toBe('2026-09-30')
  })

  it('books on the supply date even where the two agree', () => {
    // invoice-sample.xml was supplied and issued on the same day; the rule
    // must not depend on them differing.
    const d = draftFromUbl(ubl({ deliveryDate: '2026-09-15', issueDate: '2026-09-15' }), row, 'p1', null)
    expect(d.invoice_date).toBe('2026-09-15')
  })

  it('carries an invoice’s amount positive', () => {
    expect(draftFromUbl(inv2(), row, 'p1', null).amount).toBe(13436.42)
  })

  /** The credit note's figures are all positive in the XML. By the time they
   *  reach the dialog the amount must be negative, and the draft must say what
   *  it is. */
  it('carries a credit note’s negative amount, marked as a credit note', () => {
    const d = draftFromUbl(credit(), row, 'p1', null)
    expect(d.amount).toBe(-1500)
    expect(d.note).toMatch(/knjižno odobrenje/i)
  })

  it('has no due date where the credit note has none', () => {
    expect(draftFromUbl(credit(), row, 'p1', null).due_date).toBeNull()
  })

  it('does not mark an ordinary invoice as a credit note', () => {
    expect(String(draftFromUbl(inv2(), row, 'p1', null).note ?? '')).not.toMatch(/odobrenje/i)
  })
})

describe('what the owner is told before confirming', () => {
  const inv2 = () => parseUbl(fixture('invoice-sample-2.xml'))
  const credit = () => parseUbl(fixture('credit-note-sample.xml'))
  const plain = ubl()
  const base = { matchedBy: 'pib' as const, proposal, saved: [] as string[] }

  describe('which company the bill is addressed to', () => {
    it('names the company and says where it came from', () => {
      const text = reviewNotesFor(plain, {
        ...base, company: { by: 'pib' as const, name: 'Primalac d.o.o.' },
      }).join(' ')
      expect(text).toMatch(/Primalac d\.o\.o\./)
      expect(text).toMatch(/PIB/)
    })

    it('says so when it came from the registration number instead', () => {
      const text = reviewNotesFor(plain, {
        ...base, company: { by: 'registration' as const, name: 'Primalac d.o.o.' },
      }).join(' ')
      expect(text).toMatch(/matičnom broju/i)
      expect(text).not.toMatch(/PIB/)
    })

    it('says plainly that none was filled in, and that it must be picked', () => {
      const text = reviewNotesFor(plain, {
        ...base, company: { by: null, name: null },
      }).join(' ')
      expect(text).toMatch(/PIB i matični broj ovde nisu upisani/i)
      expect(text).toMatch(/Izaberite je pre knjiženja/i)
    })

    it('says nothing about a company where the caller matched none at all', () => {
      expect(reviewNotesFor(plain, base).join(' ')).not.toMatch(/Glasi na|Izaberite je pre/i)
    })
  })

  /** A proposal without its reason is a filled field nobody checked. */
  it('gives the proposal with its reason', () => {
    const notes = reviewNotesFor(plain, { ...base, proposal: { ...proposal, reason: 'Poslednje 3 fakture knjižene su ovde.' } })
    const line = notes.find(n => /Predložena/.test(n)) as string
    expect(line).toContain('Operating expenses')
    expect(line).toContain('Poslednje 3 fakture')
  })

  /** An empty classification must not look like an oversight. */
  it('says so when nothing could be proposed', () => {
    const notes = reviewNotesFor(plain, { ...base, proposal: null })
    expect(notes.join(' ')).toMatch(/Klasifikacija nije predložena/i)
  })

  it('lists every account a bill offers, and says none was chosen', () => {
    const notes = reviewNotesFor(inv2(), { ...base, saved: [] }).join(' ')
    expect(notes).toContain('220-000003-64')
    expect(notes).toContain('170-30000000003-11')
    expect(notes).toContain('160-000003-49')
    expect(notes).toMatch(/Nijedan nije izabran/i)
  })

  it('says which account was used where one of several is already saved', () => {
    const notes = reviewNotesFor(inv2(), { ...base, saved: ['170-30000000003-11'] }).join(' ')
    expect(notes).toMatch(/već sačuvan/i)
    expect(notes).not.toMatch(/Nijedan nije izabran/i)
  })

  it('says nothing about accounts where the bill names one', () => {
    expect(reviewNotesFor(plain, base).join(' ')).not.toMatch(/račun/i)
  })

  it('says it is a credit note, entered negative', () => {
    expect(reviewNotesFor(credit(), base).join(' ')).toMatch(/knjižno odobrenje.*negativan/i)
  })

  /** What the supplier sent, carried as sent and pointed out. */
  it('points out a due date before the issue date', () => {
    const notes = reviewNotesFor(inv2(), base).join(' ')
    expect(notes).toContain('2026-09-08')
    expect(notes).toContain('2026-09-14')
    expect(notes).toMatch(/je pre datuma izdavanja/i)
  })

  it('does not mention dates that are in order', () => {
    expect(reviewNotesFor(plain, base).join(' ')).not.toMatch(/dospeća/i)
  })

  /** The owner decides from the header and books from the document. When the
   *  two disagree, the figure he decided on is not the one being booked. */
  describe('where the queue header and the document disagree', () => {
    it('names both amounts', () => {
      const text = reviewNotesFor(ubl({ total: 12500 }), {
        ...base, header: { amount: 12000, currency: 'RSD' },
      }).join(' ')
      expect(text).toContain('12000.00 RSD')
      expect(text).toContain('12500.00 RSD')
      expect(text).toMatch(/Knjiži se iznos iz dokumenta/)
    })

    it('names both currencies', () => {
      const text = reviewNotesFor(ubl({ currency: 'EUR' }), {
        ...base, header: { amount: 12000, currency: 'RSD' },
      }).join(' ')
      expect(text).toMatch(/stajala u RSD, a dokument je u EUR/)
    })

    it('says nothing where they agree', () => {
      const text = reviewNotesFor(ubl(), { ...base, header: { amount: 12000, currency: 'RSD' } }).join(' ')
      expect(text).not.toMatch(/U sandučetu je ova faktura stajala/)
    })

    /** Sub-cent noise is not a disagreement; a note that cried wolf is skimmed. */
    it('ignores a difference below a cent', () => {
      const text = reviewNotesFor(ubl({ total: 12000.004 }), { ...base, header: { amount: 12000, currency: 'RSD' } }).join(' ')
      expect(text).not.toMatch(/U sandučetu je ova faktura stajala/)
    })

    /** The parser signs a credit note's total; whether the queue holds it signed
     *  is not known, and the same figure either way is not a disagreement. */
    it('does not mistake a credit note’s sign for a different amount', () => {
      const note = ubl({ total: -1500, isCreditNote: true })
      expect(reviewNotesFor(note, { ...base, header: { amount: 1500, currency: 'RSD' } }).join(' '))
        .not.toMatch(/U sandučetu je ova faktura stajala/)
      expect(reviewNotesFor(note, { ...base, header: { amount: -1500, currency: 'RSD' } }).join(' '))
        .not.toMatch(/U sandučetu je ova faktura stajala/)
    })

    it('says nothing where either side has no figure to compare', () => {
      expect(reviewNotesFor(ubl(), { ...base, header: { amount: null, currency: null } }).join(' '))
        .not.toMatch(/U sandučetu je ova faktura stajala/)
      expect(reviewNotesFor(ubl(), base).join(' ')).not.toMatch(/U sandučetu je ova faktura stajala/)
    })
  })

  it('warns when the supplier was matched by name only', () => {
    expect(reviewNotesFor(plain, { ...base, matchedBy: 'name' }).join(' ')).toMatch(/samo po imenu/i)
  })

  /** A strong match needs no comment; one that cried wolf would be skimmed. */
  it('does not warn about a match on the PIB or the registration number', () => {
    for (const matchedBy of ['pib', 'registration'] as const) {
      const text = reviewNotesFor(plain, { ...base, matchedBy }).join(' ')
      expect(text).not.toMatch(/samo po imenu/i)
      expect(text).not.toMatch(/Nijedan partner/i)
    }
  })

  it('says when no partner matched', () => {
    expect(reviewNotesFor(plain, { ...base, matchedBy: null }).join(' ')).toMatch(/Nijedan partner/i)
  })
})

describe('a draft that declined to choose an account', () => {
  const inv2 = () => parseUbl(fixture('invoice-sample-2.xml'))

  /** The dialog's account picker offers the partner's primary wherever a
   *  record says nothing; this draft HAS said something, and must be told
   *  apart from one that did not. */
  it('is marked unresolved when a bill offers several and none is saved', () => {
    expect(draftFromUbl(inv2(), row, 'p1', null, []).unresolved).toBe(true)
  })

  it('is marked unresolved when several are saved and so no one is settled on', () => {
    expect(draftFromUbl(inv2(), row, 'p1', null, ['220-000003-64', '160-000003-49']).unresolved).toBe(true)
  })

  it('is not marked when one of several was settled on', () => {
    const d = draftFromUbl(inv2(), row, 'p1', null, ['160-000003-49'])
    expect(d.account_number).toBe('160-000003-49')
    expect('unresolved' in d).toBe(false)
  })

  it('is not marked when the bill names one account', () => {
    expect('unresolved' in draftFromUbl(ubl(), row, 'p1', null)).toBe(false)
  })

  /** Nothing was named, so nothing was declined: the default is a help. */
  it('is not marked when the bill names no account at all', () => {
    const d = draftFromUbl(ubl({ bankAccount: null, bankAccounts: [] }), row, 'p1', null)
    expect(d.account_number).toBeNull()
    expect('unresolved' in d).toBe(false)
  })
})
