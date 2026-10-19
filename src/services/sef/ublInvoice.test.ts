import fs from 'fs'
import path from 'path'
import { parseUbl } from './ublInvoice'

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

// Every expected value below was read out of the fixture it is asserted
// against. The fixtures are real documents from SEF, with the base64 PDFs
// replaced by a marker; the brief these tests replace was written before
// anyone had seen one, and several of its assumptions did not survive.

describe('reading a Serbian e-invoice, against real documents', () => {
  const inv = () => parseUbl(fixture('invoice-sample.xml'))
  const inv2 = () => parseUbl(fixture('invoice-sample-2.xml'))
  const credit = () => parseUbl(fixture('credit-note-sample.xml'))

  describe('the number', () => {
    /** `cbc:ID` is everywhere in a UBL document: inside TaxScheme, in
     *  BuyersItemIdentification, in PayeeFinancialAccount, on every line, and
     *  in invoice-sample.xml in a ContractDocumentReference (17000004). The
     *  invoice number is the one that is a direct child of the body root. */
    it('is the body root’s own ID, not a nested one', () => {
      expect(inv().invoiceNumber).toBe('KR1370630/26')
      expect(inv2().invoiceNumber).toBe('R-26215/26-VP')
      expect(credit().invoiceNumber).toBe('26-07-558396')
    })
  })

  describe('the dates and the currency', () => {
    /** The issue date is the reason the document is fetched at all: the queue
     *  is built from headers, and headers carry no issue date. */
    it('reads the true issue date', () => {
      expect(inv().issueDate).toBe('2026-09-15')
      expect(inv2().issueDate).toBe('2026-09-14')
      expect(credit().issueDate).toBe('2026-10-07')
    })

    it('reads the due date, and returns null when there is none', () => {
      expect(inv().dueDate).toBe('2026-09-15')
      expect(inv2().dueDate).toBe('2026-09-08')
      // The credit note has no DueDate element at all.
      expect(credit().dueDate).toBeNull()
    })

    /** `currency` is the one the invoice is BOOKED in, which on a bill
     *  indexed in euros is the dinar. What the supplier wrote it in is kept
     *  separately. */
    it('reads the currency the invoice is booked in', () => {
      expect(inv().currency).toBe('RSD')
      expect(inv2().currency).toBe('RSD')
      expect(credit().currency).toBe('RSD')
    })

    it('keeps the currency the supplier wrote it in, beside it', () => {
      expect(inv().documentCurrency).toBe('EUR')
      expect(inv().documentTotal).toBe(298.59)
      expect(inv2().documentCurrency).toBe('RSD')
      expect(inv2().documentTotal).toBe(13436.42)
    })
  })

  describe('the supplier', () => {
    /** The PIB is the exact key into `partners.tax_id`. SEF writes it as
     *  `RS100000004` in PartyTaxScheme and bare in EndpointID; the prefix has
     *  to come off or nothing matches. */
    it('reads the PIB as digits, with the RS stripped', () => {
      expect(inv().supplierVatNumber).toBe('100000004')
      expect(inv2().supplierVatNumber).toBe('100000003')
      expect(credit().supplierVatNumber).toBe('100000002')
    })

    it('reads the registration number, keeping its leading zero', () => {
      expect(inv().supplierRegistrationNumber).toBe('07000004')
      expect(inv2().supplierRegistrationNumber).toBe('20000003')
      expect(credit().supplierRegistrationNumber).toBe('07000002')
    })

    /** Not the customer's. The same document carries our own company as
     *  AccountingCustomerParty, with its own PIB 100000001. */
    it('reads the supplier, not the customer', () => {
      expect(inv().supplierName).toBe('PRVA BANKA AD BEOGRAD')
      expect(inv2().supplierName).toBe('KANCELARIJA DOO BEOGRAD')
      expect(credit().supplierName).toBe('JKP KOMUNALNO BEOGRAD')
      expect(inv().supplierVatNumber).not.toBe('100000001')
    })
  })

  describe('the date of supply', () => {
    /** The tax point. This, not the issue date, is what an invoice is booked
     *  on and what its exchange rate is taken on — and on most real bills the
     *  two differ by days. */
    it('reads it, and it is not the issue date', () => {
      expect(inv2().deliveryDate).toBe('2026-09-08')
      expect(inv2().issueDate).toBe('2026-09-14')
      expect(credit().deliveryDate).toBe('2026-10-06')
      expect(credit().issueDate).toBe('2026-10-07')
    })

    it('reads it where it happens to equal the issue date', () => {
      expect(inv().deliveryDate).toBe('2026-09-15')
      expect(inv().issueDate).toBe('2026-09-15')
    })

    it('is null on a document that names none', () => {
      expect(parseUbl('<Invoice><cbc:ID>1</cbc:ID></Invoice>').deliveryDate).toBeNull()
    })
  })

  describe('the customer — which of the owner’s companies the bill is for', () => {
    /** The owner runs several companies and SEF delivers to a legal person.
     *  Booked against the wrong one, a cost lands in the wrong P&L, the wrong
     *  VAT return and the wrong cash plan, and looks ordinary in all three. */
    it('reads the PIB of the party the bill is addressed to, without the country prefix', () => {
      // `RS100000001` in all three documents; `company_profiles.pib` holds digits.
      expect(inv().customerVatNumber).toBe('100000001')
      expect(inv2().customerVatNumber).toBe('100000001')
      expect(credit().customerVatNumber).toBe('100000001')
    })

    it('reads the customer registration number', () => {
      expect(inv().customerRegistrationNumber).toBe('20000001')
      expect(inv2().customerRegistrationNumber).toBe('20000001')
    })

    /** The reason `matchCompany` refuses to match on a name: these three real
     *  documents are addressed to ONE company and spell it three ways, while
     *  the PIB above is identical in all of them. */
    it('reads the customer name as the supplier spelt it, which is three ways across three bills', () => {
      expect(inv().customerName).toBe('Primalac d.o.o. Beograd')
      expect(inv2().customerName).toBe('PRIMALAC D.O.O.')
      expect(credit().customerName).toBe('PRIMALAC DOO BEOGRAD')
    })

    it('does not confuse the customer with the supplier', () => {
      const i = inv()
      expect(i.customerVatNumber).not.toBe(i.supplierVatNumber)
      expect(i.customerName).not.toBe(i.supplierName)
    })

    it('leaves the customer null on a document that has no customer party', () => {
      const bare = parseUbl('<Invoice><cbc:ID>1</cbc:ID></Invoice>')
      expect(bare.customerVatNumber).toBeNull()
      expect(bare.customerRegistrationNumber).toBeNull()
      expect(bare.customerName).toBeNull()
    })
  })


  describe('the bank account', () => {
    /** The account ON THIS BILL. Falling back to the partner's primary is the
     *  fault fixed in `f633370`. */
    it('reads the account from PayeeFinancialAccount', () => {
      expect(inv().bankAccount).toBe('908000000000000004')
      expect(credit().bankAccount).toBe('205000000000000002')
    })

    /** KANCELARIJA lists three accounts in one element, separated by semicolons.
     *  The parser hands the string over as the supplier wrote it; choosing one
     *  is for the person booking it. */
    it('hands over a supplier’s list of accounts unsplit', () => {
      expect(inv2().bankAccount).toBe('220-000003-64;  170-30000000003-11; 160-000003-49')
    })

    /** The same field, split on `;` and trimmed, so a reader choosing between
     *  accounts does not have to parse a string to find them. `bankAccount`
     *  stays raw: it is what the supplier wrote. */
    it('also lists them one by one', () => {
      expect(inv2().bankAccounts).toEqual(['220-000003-64', '170-30000000003-11', '160-000003-49'])
    })

    it('lists a single account as a list of one', () => {
      expect(inv().bankAccounts).toEqual(['908000000000000004'])
      expect(credit().bankAccounts).toEqual(['205000000000000002'])
    })

    it('lists nothing where the bill names no account', () => {
      expect(parseUbl('<Invoice><cbc:ID xmlns:cbc="x">1</cbc:ID></Invoice>').bankAccounts).toEqual([])
    })

    /** A trailing separator is typography, not an account. */
    it('drops an empty entry left by a stray separator', () => {
      const xml = fixture('invoice-sample-2.xml')
        .replace('160-000003-49</cbc:ID>', '160-000003-49;</cbc:ID>')
      expect(parseUbl(xml).bankAccounts).toHaveLength(3)
    })

    it('returns null for a bill that names no account, rather than throwing', () => {
      const stripped = fixture('invoice-sample.xml')
        .replace(/<cac:PayeeFinancialAccount>[\s\S]*?<\/cac:PayeeFinancialAccount>/g, '')
      expect(parseUbl(stripped).bankAccount).toBeNull()
    })
  })

  describe('the money', () => {
    /**
     * THIS IS THE TEST THAT MATTERS. invoice-sample.xml is a loan interest
     * statement written in EUR with TaxCurrencyCode RSD, and it carries a
     * TaxTotal in each. The euro is only the index: the bill is for 35,045.51
     * dinars and that is what is owed, paid and declared. Booked at 298.59 it
     * is out by a factor of a hundred, and nothing about the number looks
     * wrong.
     *
     * `LegalMonetaryTotal` exists only in euros, so the dinar figures come
     * from the dinar TaxTotal and the total is their sum.
     */
    it('books an indexed bill in dinars, not in the currency it is written in', () => {
      expect(inv().net).toBe(35045.51)
      expect(inv().vat).toBe(0)
      expect(inv().total).toBe(35045.51)
    })

    /** Both VAT figures are 0 in the real document, so the figure alone
     *  cannot say which block was read. Changed here, it can. */
    it('takes the VAT from the tax currency, not from the one written first', () => {
      const xml = fixture('invoice-sample.xml')
        .replace('<cbc:TaxAmount currencyID="RSD">0</cbc:TaxAmount>',
                 '<cbc:TaxAmount currencyID="RSD">4200.55</cbc:TaxAmount>')
        .replace('<cbc:TaxAmount currencyID="EUR">0</cbc:TaxAmount>',
                 '<cbc:TaxAmount currencyID="EUR">17.25</cbc:TaxAmount>')
      const i = parseUbl(xml)
      expect(i.vat).toBe(4200.55)
      expect(i.total).toBe(39246.06)   // 35,045.51 + 4,200.55
    })

    /** A document that names a tax currency but states no figures in it has
     *  nothing to book from there, and its own currency is all there is. */
    it('stays in the written currency where the tax currency has no figures', () => {
      const xml = fixture('invoice-sample.xml')
        .replace('<cbc:TaxAmount currencyID="RSD">0</cbc:TaxAmount>',
                 '<cbc:TaxAmount currencyID="XXX">0</cbc:TaxAmount>')
      const i = parseUbl(xml)
      expect(i.currency).toBe('EUR')
      expect(i.total).toBe(298.59)
    })

    it('leaves a bill with no tax currency exactly as it was', () => {
      const xml = fixture('invoice-sample.xml')
        .replace('<cbc:TaxCurrencyCode>RSD</cbc:TaxCurrencyCode>', '')
      const i = parseUbl(xml)
      expect(i.currency).toBe('EUR')
      expect(i.net).toBe(298.59)
      expect(i.total).toBe(298.59)
    })

    it('reads net, VAT and total on a single-currency invoice', () => {
      const i = inv2()
      expect(i.net).toBe(11197.02)
      expect(i.vat).toBe(2239.4)
      expect(i.total).toBe(13436.42)
    })
  })

  describe('the payment reference', () => {
    /** invoice-sample.xml has no PaymentID at all. */
    it('is null, with a null model, when the bill has none — and nothing throws', () => {
      expect(() => inv()).not.toThrow()
      expect(inv().paymentReference).toBeNull()
      expect(inv().paymentModel).toBeNull()
    })

    it('is the whole value, with no model, when there is no marker', () => {
      expect(inv2().paymentReference).toBe('26215/26-VP')
      expect(inv2().paymentModel).toBeNull()
    })

    it('splits a model marker from the reference', () => {
      expect(credit().paymentModel).toBe('97')
      expect(credit().paymentReference).toBe('108113652782')
    })

    it('does not mistake a marker with nothing after it for a reference', () => {
      const xml = fixture('credit-note-sample.xml')
        .replace('(mod97) 108113652782', '(mod97)')
      expect(parseUbl(xml).paymentModel).toBe('97')
      expect(parseUbl(xml).paymentReference).toBeNull()
    })
  })

  describe('a credit note', () => {
    /** Its type code lives in `CreditNoteTypeCode`, not `InvoiceTypeCode`. A
     *  parser that reads only the latter gets null, calls it an ordinary bill,
     *  and books it as a positive cost — wrong in the P&L and in the payables
     *  at once, and indistinguishable from a real bill on screen. */
    it('is recognised, and its total is negative', () => {
      const c = credit()
      expect(c.typeCode).toBe('381')
      expect(c.isCreditNote).toBe(true)
      expect(c.total).toBe(-1500)
    })

    it('is recognised by its root when the type code is absent', () => {
      const xml = fixture('credit-note-sample.xml')
        .replace('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>', '')
      const c = parseUbl(xml)
      expect(c.typeCode).toBeNull()
      expect(c.isCreditNote).toBe(true)
      expect(c.total).toBe(-1500)
    })

    it('reads its CreditNoteLine and CreditedQuantity', () => {
      const c = credit()
      expect(c.lines).toHaveLength(1)
      expect(c.lines[0].lineId).toBe('1')
      expect(c.lines[0].quantity).toBe(1)
      expect(c.lines[0].lineAmount).toBe(1250)
      expect(c.lines[0].vatPercent).toBe(20)
      expect(c.lines[0].name).toMatch(/^Ljubičasta podzona A\.1 13652782/)
    })

    /** The document states every amount of a credit note positive — 1250 net,
     *  250 VAT, 1500 payable — and the parser signs the total. Signing only the
     *  total leaves net and VAT to be negated by whoever reads them, so the
     *  three would be three rules to remember downstream. One rule, held here:
     *  every figure that comes out of a credit note is negative, and
     *  net + vat = total still holds. */
    it('signs net and VAT as well as the total', () => {
      const c = credit()
      expect(c.net).toBe(-1250)
      expect(c.vat).toBe(-250)
      expect(c.total).toBe(-1500)
      expect((c.net as number) + (c.vat as number)).toBe(c.total)
    })

    /** A credit note with no VAT is a real thing, and `-Math.abs(0)` is
     *  negative zero, which `toBe(0)` and `JSON.stringify` both distinguish. */
    it('keeps a credit note’s zero VAT as plain zero', () => {
      const xml = fixture('credit-note-sample.xml')
        .replace(/<cbc:TaxAmount currencyID="RSD">250.0<\/cbc:TaxAmount>/g,
          '<cbc:TaxAmount currencyID="RSD">0</cbc:TaxAmount>')
      expect(Object.is(parseUbl(xml).vat, 0)).toBe(true)
    })

    it('leaves an ordinary invoice’s net and VAT positive', () => {
      expect(inv2().net).toBe(11197.02)
      expect(inv2().vat).toBe(2239.4)
    })

    it('an ordinary invoice is not one', () => {
      expect(inv().typeCode).toBe('380')
      expect(inv().isCreditNote).toBe(false)
      expect(inv2().isCreditNote).toBe(false)
    })
  })

  describe('the lines', () => {
    it('reads the one line of invoice-sample.xml', () => {
      const i = inv()
      expect(i.lines).toHaveLength(1)
      expect(i.lines[0].name).toBe('KREDITI - redovna kamata')
      expect(i.lines[0].lineAmount).toBe(298.59)
      expect(i.lines[0].quantity).toBe(1)
      expect(i.lines[0].vatPercent).toBe(0)
    })

    it('reads the seven lines of invoice-sample-2.xml', () => {
      const i = inv2()
      expect(i.lines).toHaveLength(7)
      expect(i.lines[0].name).toBe('Sef KSF mini - 2818 EL')
      expect(i.lines[0].lineAmount).toBe(4900)
      expect(i.lines[0].vatPercent).toBe(20)
      expect(i.lines[1].quantity).toBe(5)
      expect(i.lines[6].name).toBe('Bušač Maped Essential Metal 20/25')
    })

    /** No `cac:Item` in any of the three captured documents has a
     *  `cbc:Description`. The field exists in the interface and must be null,
     *  not an error and not the name repeated. */
    it('tolerates a line with no description', () => {
      expect(inv().lines[0].description).toBeNull()
      expect(inv2().lines[0].description).toBeNull()
    })

    it('reads a description when the supplier gives one', () => {
      const xml = fixture('invoice-sample.xml')
        .replace('<cbc:Name>KREDITI - redovna kamata</cbc:Name>',
                 '<cbc:Description>Interest for September</cbc:Description><cbc:Name>KREDITI - redovna kamata</cbc:Name>')
      expect(parseUbl(xml).lines[0].description).toBe('Interest for September')
    })

    /** The line's own `cbc:ID` is "1", and the BuyersItemIdentification
     *  inside it is "BNKTR:". Only the first is the line's. */
    it('takes the line id from the line, not from the item inside it', () => {
      expect(inv().lines[0].lineId).toBe('1')
    })
  })

  describe('the envelope', () => {
    /** `sef_inbox.sef_invoice_id` holds the purchase id. Comparing it to this
     *  is a free check that the document is the one that was asked for. */
    it('reads the purchase invoice id', () => {
      expect(inv().sefPurchaseInvoiceId).toBe('473450675')
      expect(inv2().sefPurchaseInvoiceId).toBe('472902033')
      expect(credit().sefPurchaseInvoiceId).toBe('482178106')
    })

    it('is null for a bare Invoice with no envelope, which still parses', () => {
      const bare = fixture('invoice-sample-2.xml')
        .replace(/[\s\S]*<env:DocumentBody>/, '')
        .replace(/<\/env:DocumentBody>[\s\S]*/, '')
      const i = parseUbl(bare)
      expect(i.sefPurchaseInvoiceId).toBeNull()
      expect(i.invoiceNumber).toBe('R-26215/26-VP')
    })
  })

  describe('something that is not an invoice', () => {
    it('does not throw, and returns nulls', () => {
      expect(() => parseUbl('<nonsense/>')).not.toThrow()
      const n = parseUbl('<nonsense/>')
      expect(n.invoiceNumber).toBeNull()
      expect(n.issueDate).toBeNull()
      expect(n.total).toBeNull()
      expect(n.sefPurchaseInvoiceId).toBeNull()
      expect(n.isCreditNote).toBe(false)
      expect(n.lines).toEqual([])
    })

    it('survives text that is not XML, and an empty string', () => {
      expect(() => parseUbl('this is not xml <<<')).not.toThrow()
      expect(() => parseUbl('')).not.toThrow()
      expect(parseUbl('').invoiceNumber).toBeNull()
    })
  })
})

describe('which bill a note adjusts, and a debit note', () => {
  const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

  it('reads the bill a credit note refers to', () => {
    expect(parseUbl(fx('credit-note-sample.xml')).billingReference).toBe('26-03-892094')
  })

  it('a bill with no reference has none, and is not a debit note', () => {
    const b = parseUbl(fx('invoice-sample.xml'))
    expect(b.billingReference).toBeNull()
    expect(b.isDebitNote).toBe(false)
  })

  it('type 383 is a debit note, positive', () => {
    const d = parseUbl(fx('invoice-sample.xml').replace('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:InvoiceTypeCode>383</cbc:InvoiceTypeCode>'))
    expect(d.isDebitNote).toBe(true)
    expect(d.isCreditNote).toBe(false)
    expect(d.total).toBeGreaterThan(0)
  })
})
