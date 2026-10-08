import {
  personKey, matchEmployeeToPartner, matchEmployeesToPartners, unmatchedEmployees,
  employeeNameFromNote, matchPayeeToPartner, findTaxAuthority,
  matchDeductionPartners, classifyPostedNote, payrollMonthFromNote,
  postingTag, hasPostingTag, POSTED_NOTE_FILTER,
  type PartnerLike,
} from './partnerMatch'

const p = (id: string, name: string, is_individual: boolean | null = true): PartnerLike =>
  ({ id, name, is_individual })

describe('personKey', () => {
  /** A payroll export puts the surname first; most partner records do not. */
  it('does not care which way round the name was typed', () => {
    expect(personKey('Jeličić Branislav')).toBe(personKey('Branislav Jeličić'))
  })

  it('folds the accents half the partner records were typed without', () => {
    expect(personKey('Jeličić Branislav')).toBe(personKey('Jelicic Branislav'))
    expect(personKey('Đurađ Šipka')).toBe(personKey('Djuradj Sipka'))
  })

  it('ignores case, punctuation and extra spaces', () => {
    expect(personKey('  GAVRILOV,  dejan ')).toBe(personKey('Dejan Gavrilov'))
  })

  it('keeps two different people apart', () => {
    expect(personKey('Dejan Gavrilov')).not.toBe(personKey('Dejan Simonović'))
  })

  it('does not collapse a middle name into nothing', () => {
    expect(personKey('Ana Marija Petrović')).not.toBe(personKey('Ana Petrović'))
  })

  it('has nothing to say about an empty name', () => {
    expect(personKey('')).toBe('')
    expect(personKey(null)).toBe('')
  })

  /**
   * Cyrillic is deliberately left alone: transliterating is a guess about
   * which convention was used, and a name that does not match is reported
   * rather than matched to the wrong person.
   */
  it('does not pretend to transliterate Cyrillic', () => {
    expect(personKey('Дејан Гаврилов')).not.toBe(personKey('Dejan Gavrilov'))
  })
})

describe('matching an employee to a partner', () => {
  const book = [
    p('i1', 'Branislav Jelicic'),
    p('i2', 'Dejan Gavrilov'),
    p('c1', 'Dejan Gavrilov PR', false),
    p('c2', 'Zenit d.o.o.', false),
  ]

  it('finds the individual whose name is the same name', () => {
    const m = matchEmployeeToPartner('Jeličić Branislav', book)
    expect(m.partnerId).toBe('i1')
    expect(m.reason).toBe('matched')
  })

  /**
   * The mistake `is_individual` exists to prevent: a salary filed against a
   * company's account, which looks perfectly ordinary in every report.
   */
  it('will not match an employee to a company of the same name', () => {
    const m = matchEmployeeToPartner('Zenit', [p('c2', 'Zenit', false)])
    expect(m.partnerId).toBeNull()
    expect(m.reason).toBe('not_individual')
    expect(m.candidates.map(c => c.id)).toEqual(['c2'])
  })

  /** Two people genuinely share a name, or one record is a duplicate. Either
   *  way, picking the first files a salary against somebody else. */
  it('refuses to choose when two individuals carry the name', () => {
    const m = matchEmployeeToPartner('Dejan Gavrilov', [
      p('i2', 'Dejan Gavrilov'), p('i3', 'Gavrilov Dejan'),
    ])
    expect(m.partnerId).toBeNull()
    expect(m.reason).toBe('ambiguous')
    expect(m.candidates).toHaveLength(2)
  })

  it('is not confused by a company that merely looks similar', () => {
    expect(matchEmployeeToPartner('Dejan Gavrilov', book).partnerId).toBe('i2')
  })

  it('says plainly when nobody carries the name', () => {
    const m = matchEmployeeToPartner('Milan Nepostojeći', book)
    expect(m.partnerId).toBeNull()
    expect(m.reason).toBe('none')
  })

  it('matches nothing to an employee with no name', () => {
    expect(matchEmployeeToPartner('', book).partnerId).toBeNull()
    expect(matchEmployeeToPartner(null, book).partnerId).toBeNull()
  })
})

describe('a whole run at once', () => {
  const book = [p('i1', 'Branislav Jelicic'), p('i2', 'Dejan Gavrilov')]
  const staff = [
    { id: 'e1', name: 'Jeličić Branislav' },
    { id: 'e2', name: 'Gavrilov Dejan' },
    { id: 'e3', name: 'Neko Nepoznat' },
  ]

  it('gives every employee an answer, including no answer', () => {
    expect(matchEmployeesToPartners(staff, book)).toEqual({
      e1: 'i1', e2: 'i2', e3: null,
    })
  })

  /** What the screen needs: who was not matched, and what to do about it. */
  it('lists the ones that need a person to look at them', () => {
    expect(unmatchedEmployees(staff, book)).toEqual([
      { id: 'e3', name: 'Neko Nepoznat', reason: 'none' },
    ])
  })

  it('reports an unflagged partner as its own kind of problem', () => {
    const out = unmatchedEmployees(
      [{ id: 'e9', name: 'Marko Marković' }],
      [p('c9', 'Marko Marković', false)])
    expect(out[0].reason).toBe('not_individual')
  })
})

describe('reading the employee out of a posted row', () => {
  it('finds the name on a net salary row', () => {
    expect(employeeNameFromNote('2026-08 Standard — Net salary — Gavrilov Dejan [posting 4f2]'))
      .toBe('Gavrilov Dejan')
  })

  /** The net leg says what was forwarded to third parties after the name. */
  it('stops at the forwarding clause rather than swallowing it', () => {
    expect(employeeNameFromNote('2026-08 — Net salary — Gavrilov Dejan, after 3000 forwarded [posting 4f2]'))
      .toBe('Gavrilov Dejan')
  })

  it('reads a row that was written without a posting tag', () => {
    expect(employeeNameFromNote('2026-08 — Net salary — Ana Marija Petrović'))
      .toBe('Ana Marija Petrović')
  })

  /**
   * A backfill that guessed would put a person's name on a row that is not a
   * salary — an obligation to the tax authority, a deduction forwarded to a
   * bank — and those rows are correct with no partner or with another one.
   */
  it('says nothing about a row that is not somebody’s salary', () => {
    expect(employeeNameFromNote('2026-08 — Tax and contributions [posting 4f2]')).toBeNull()
    expect(employeeNameFromNote('2026-08 — Retained deduction (storno): Loan — Gavrilov Dejan')).toBeNull()
    expect(employeeNameFromNote('')).toBeNull()
    expect(employeeNameFromNote(null)).toBeNull()
  })
})


describe('matching a company payee', () => {
  const book = [
    p('g1', 'Generali Osiguranje a.d.o.', false),
    p('g2', 'Generali Investments d.o.o.', false),
    p('t1', 'PORESKA UPRAVA OBJEDINJENA NAPLATA', false),
  ]

  it('reads past the legal form', () => {
    expect(matchPayeeToPartner('Generali Osiguranje', book).partnerId).toBe('g1')
  })

  it('ignores the case the tax authority happens to be typed in', () => {
    expect(findTaxAuthority(book).partnerId).toBe('t1')
  })

  /**
   * The substring rule that makes `Generali` find `Generali Osiguranje` also
   * makes it find `Generali Investments`. A deduction on the wrong insurer
   * account is a payment nobody can trace.
   */
  it('refuses to choose between two companies sharing a word', () => {
    const m = matchPayeeToPartner('Generali', book)
    expect(m.partnerId).toBeNull()
    expect(m.reason).toBe('ambiguous')
    expect(m.candidates).toHaveLength(2)
  })

  it('takes an exact name even where a looser rule would find several', () => {
    expect(matchPayeeToPartner('Generali Investments d.o.o.', book).partnerId).toBe('g2')
  })

  it('says so when the payee is not in the book', () => {
    expect(matchPayeeToPartner('Wiener Stadtische', book).reason).toBe('none')
    expect(matchPayeeToPartner('', book).reason).toBe('none')
    expect(matchPayeeToPartner(null, book).reason).toBe('none')
  })
})

describe('deduction payees across a whole staff', () => {
  const book = [p('g1', 'Generali Osiguranje a.d.o.', false), p('b1', 'Banca Intesa', false)]

  it('matches every third-party deduction to its payee', () => {
    expect(matchDeductionPartners([
      { id: 'd1', goes_to: 'third_party', payee: 'Generali Osiguranje' },
      { id: 'd2', goes_to: 'third_party', payee: 'Banca Intesa a.d.' },
    ], book)).toEqual({ d1: 'g1', d2: 'b1' })
  })

  /** An employer deduction cancels an expense already booked. It has no payee
   *  and wants no partner. */
  it('leaves an employer deduction out entirely', () => {
    expect(matchDeductionPartners([
      { id: 'd3', goes_to: 'employer', payee: 'Generali Osiguranje' },
    ], book)).toEqual({})
  })

  it('records a payee it could not place as null rather than omitting it', () => {
    expect(matchDeductionPartners([
      { id: 'd4', goes_to: 'third_party', payee: 'Nepoznato d.o.o.' },
    ], book)).toEqual({ d4: null })
  })
})

describe('classifying a posted row', () => {
  it('knows a salary from a tax obligation from a deduction', () => {
    expect(classifyPostedNote('Payroll 2026-08 — Standard — Net salary — Gavrilov Dejan [posting 1]'))
      .toEqual({ kind: 'employee', name: 'Gavrilov Dejan' })
    expect(classifyPostedNote('Payroll 2026-08 — Standard — Tax and contributions [posting 1]'))
      .toEqual({ kind: 'tax' })
    expect(classifyPostedNote('Payroll 2026-08 — Deduction forwarded: Generali — Gavrilov Dejan [posting 1]'))
      .toEqual({ kind: 'deduction', label: 'Generali', employee: 'Gavrilov Dejan' })
  })

  /** A row that is correct without a partner must not be given one. */
  it('leaves anything it does not recognise alone', () => {
    expect(classifyPostedNote('Payroll 2026-08 — Retained deduction (storno): Laptop — Ana'))
      .toEqual({ kind: 'other' })
    expect(classifyPostedNote('Some invoice typed by hand')).toEqual({ kind: 'other' })
    expect(classifyPostedNote(null)).toEqual({ kind: 'other' })
  })
})


describe('a deduction that names its payee by id', () => {
  const book = [p('g1', 'Generali Osiguranje a.d.o.', false), p('g2', 'Generali Investments d.o.o.', false)]

  /**
   * The id was chosen from the partner book by somebody who knew which
   * company they meant. No amount of clever name matching beats that.
   */
  it('takes the id over the name', () => {
    expect(matchDeductionPartners([
      { id: 'd1', goes_to: 'third_party', payee: 'Generali Investments d.o.o.', payee_partner_id: 'g1' },
    ], book)).toEqual({ d1: 'g1' })
  })

  it('resolves a payee the name alone could not', () => {
    expect(matchDeductionPartners([
      { id: 'd2', goes_to: 'third_party', payee: 'Generali', payee_partner_id: 'g2' },
    ], book)).toEqual({ d2: 'g2' })
    // Without the id, that same payee is ambiguous and stays empty.
    expect(matchDeductionPartners([
      { id: 'd2', goes_to: 'third_party', payee: 'Generali' },
    ], book)).toEqual({ d2: null })
  })

  /**
   * A partner deleted since leaves an id pointing at nothing. Posting against
   * it would be worse than posting against none, so the name gets its turn.
   */
  it('falls back to the name when the id points at a partner that is gone', () => {
    expect(matchDeductionPartners([
      { id: 'd3', goes_to: 'third_party', payee: 'Generali Osiguranje', payee_partner_id: 'deleted' },
    ], book)).toEqual({ d3: 'g1' })
  })

  it('still ignores an employer deduction, id or no id', () => {
    expect(matchDeductionPartners([
      { id: 'd4', goes_to: 'employer', payee: 'Generali', payee_partner_id: 'g1' },
    ], book)).toEqual({})
  })

  it('leaves a deduction with neither an id nor a findable name empty', () => {
    expect(matchDeductionPartners([
      { id: 'd5', goes_to: 'third_party', payee: 'Nepoznato', payee_partner_id: null },
    ], book)).toEqual({ d5: null })
  })
})


describe('the month a posted row belongs to', () => {
  it('reads it off the note', () => {
    expect(payrollMonthFromNote('Payroll 2026-09 — Standard — Net salary — Ana [posting 1]'))
      .toBe('2026-09')
  })

  /**
   * Taken from the row and not from the open month: a September run written
   * up in October falls due in September, and a backfill using the screen's
   * month would give it an October due date and be wrong unquestionably.
   */
  it('is the run month, whatever month is on screen', () => {
    expect(payrollMonthFromNote('Payroll 2026-08 — Tax and contributions [posting 2]'))
      .toBe('2026-08')
  })

  it('says nothing about a row payroll did not write', () => {
    expect(payrollMonthFromNote('Office rent September')).toBeNull()
    expect(payrollMonthFromNote(null)).toBeNull()
  })
})


// ── Notes written since the interface went Serbian ──────────────────────────
//
// The rows posted in English stay in the ledger, so every reader has to
// understand both spellings. The English cases above are the legacy rows;
// these are the ones written from now on.

describe('reading a note written in Serbian', () => {
  it('finds the name on a net salary row', () => {
    expect(employeeNameFromNote('Zarade 2026-09 — Zarade — Neto zarada — Gavrilov Dejan [knjiženje 4f2]'))
      .toBe('Gavrilov Dejan')
  })

  it('stops at the forwarding clause rather than swallowing it', () => {
    expect(employeeNameFromNote('Zarade 2026-09 — Zarade — Neto zarada — Gavrilov Dejan, nakon prosleđenih 3000 [knjiženje 4f2]'))
      .toBe('Gavrilov Dejan')
  })

  it('reads a row that was written without a posting tag', () => {
    expect(employeeNameFromNote('Zarade 2026-09 — Neto zarada — Ana Marija Petrović'))
      .toBe('Ana Marija Petrović')
  })

  it('says nothing about a row that is not somebody’s salary', () => {
    expect(employeeNameFromNote('Zarade 2026-09 — Zarade — Porez i doprinosi [knjiženje 4f2]')).toBeNull()
    expect(employeeNameFromNote('Zarade 2026-09 — Zadržana obustava (storno): Kredit — Gavrilov Dejan')).toBeNull()
  })

  it('knows a salary from a tax obligation from a deduction', () => {
    expect(classifyPostedNote('Zarade 2026-09 — Zarade — Neto zarada — Gavrilov Dejan [knjiženje 1]'))
      .toEqual({ kind: 'employee', name: 'Gavrilov Dejan' })
    expect(classifyPostedNote('Zarade 2026-09 — Zarade — Porez i doprinosi [knjiženje 1]'))
      .toEqual({ kind: 'tax' })
    expect(classifyPostedNote('Zarade 2026-09 — Zarade — Prosleđena obustava: Generali — Gavrilov Dejan [knjiženje 1]'))
      .toEqual({ kind: 'deduction', label: 'Generali', employee: 'Gavrilov Dejan' })
  })

  it('leaves a retained-deduction storno alone', () => {
    expect(classifyPostedNote('Zarade 2026-09 — Zarade — Zadržana obustava (storno): Laptop — Ana'))
      .toEqual({ kind: 'other' })
  })

  it('reads the month off the note', () => {
    expect(payrollMonthFromNote('Zarade 2026-09 — Zarade — Neto zarada — Ana [knjiženje 1]'))
      .toBe('2026-09')
    expect(payrollMonthFromNote('Zarade 2026-08 — Ostala primanja — Porez i doprinosi [knjiženje 2]'))
      .toBe('2026-08')
  })
})

describe('the posting tag', () => {
  it('is written in Serbian', () => {
    expect(postingTag('post-1')).toBe('[knjiženje post-1]')
  })

  it('is recognised in both spellings, and nowhere else', () => {
    expect(hasPostingTag('Zarade 2026-09 — Zarade — Neto zarada — Ana [knjiženje 1]')).toBe(true)
    expect(hasPostingTag('Payroll 2026-08 — Salaries — Net salary — Ana [posting 1]')).toBe(true)
    expect(hasPostingTag('Kancelarijski materijal')).toBe(false)
    expect(hasPostingTag(null)).toBe(false)
  })

  /**
   * The ledger query that finds already-posted rows. One `or` with both
   * spellings, each value quoted so the bracket and the space are read as
   * part of the pattern rather than as filter syntax.
   */
  it('is looked for in the ledger in both spellings', () => {
    expect(POSTED_NOTE_FILTER).toBe('note.like."%[posting %",note.like."%[knjiženje %"')
  })
})
