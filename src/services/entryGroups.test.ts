import {
  groupByMonth, monthKeyOf, monthLabel, amountOf,
  parseFilter, matchesAmount, matchesText, rowMatches, filterRows, summarise,
  NO_FILTER, type ParsedFilter,
} from './entryGroups'

type Row = {
  id: string
  pl_date: string
  amount_rsd: number | null
  expense_description?: string | null
}

const row = (id: string, pl_date: string, amount_rsd: number | null, expense_description?: string): Row =>
  ({ id, pl_date, amount_rsd, expense_description })

describe('the month a row belongs to', () => {
  it('reads pl_date or date, whichever the row carries', () => {
    expect(monthKeyOf({ pl_date: '2026-09-14' })).toBe('2026-09')
    expect(monthKeyOf({ date: '2026-09-14' })).toBe('2026-09')
  })

  it('prefers pl_date when a row somehow carries both', () => {
    expect(monthKeyOf({ pl_date: '2026-09-14', date: '2025-01-01' })).toBe('2026-09')
  })

  it('gives an empty key to a row with no usable date, rather than guessing', () => {
    expect(monthKeyOf({ pl_date: null })).toBe('')
    expect(monthKeyOf({ pl_date: '' })).toBe('')
    expect(monthKeyOf({ pl_date: 'not a date' })).toBe('')
  })

  it('names the month from the string, never through a Date', () => {
    // The regression this guards: `new Date('2026-09')` is UTC midnight, and
    // printing it in a negative-offset zone gives 31 August — so September's
    // heading read "August 2026" for every user west of Greenwich.
    expect(monthLabel('2026-09')).toBe('September 2026')
    expect(monthLabel('2026-01')).toBe('January 2026')
    expect(monthLabel('2026-12')).toBe('December 2026')
  })

  it('calls a month it cannot parse Undated', () => {
    expect(monthLabel('')).toBe('Undated')
  })
})

describe('grouping a drill-down into months', () => {
  const rows = [
    row('a', '2026-07-02', 100),
    row('b', '2026-09-14', 250),
    row('c', '2026-09-01', 50),
    row('d', '2026-08-30', 400),
    row('e', '2026-09-30', 25),
  ]

  it('puts the newest month first', () => {
    expect(groupByMonth(rows, 'RSD').map(g => g.key)).toEqual(['2026-09', '2026-08', '2026-07'])
  })

  it('labels, counts and totals each month', () => {
    const [sep] = groupByMonth(rows, 'RSD')
    expect(sep.label).toBe('September 2026')
    expect(sep.count).toBe(3)
    expect(sep.total).toBe(325)
  })

  it('orders the rows inside a month newest first', () => {
    const [sep] = groupByMonth(rows, 'RSD')
    expect(sep.rows.map(r => r.id)).toEqual(['e', 'b', 'c'])
  })

  it('does not reorder the caller array', () => {
    const before = rows.map(r => r.id)
    groupByMonth(rows, 'RSD')
    expect(rows.map(r => r.id)).toEqual(before)
  })

  it('totals to the node total, so the headers can never disagree with it', () => {
    // The property the whole design rests on: every row lands in exactly one
    // month, so summing the month headers reproduces the figure the modal's
    // own header shows. Nothing here is fetched, capped or sampled.
    const groups = groupByMonth(rows, 'RSD')
    const summed = groups.reduce((s, g) => s + g.total, 0)
    const counted = groups.reduce((s, g) => s + g.count, 0)
    expect(summed).toBe(rows.reduce((s, r) => s + (r.amount_rsd || 0), 0))
    expect(counted).toBe(rows.length)
  })

  it('keeps undated rows in a trailing group rather than dropping them', () => {
    const groups = groupByMonth([...rows, row('x', '', 999)], 'RSD')
    expect(groups[groups.length - 1].key).toBe('')
    expect(groups[groups.length - 1].label).toBe('Undated')
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(6)
  })

  it('totals magnitudes, the same arithmetic the tree above it uses', () => {
    // `buildTree` sums the magnitude of each book figure, so the node total in the modal
    // header is a total of magnitudes. A month that netted a refund off
    // against the spend around it would print less than the header and the
    // months would stop adding up to it.
    const [g] = groupByMonth([
      row('a', '2026-09-01', 300),
      row('b', '2026-09-02', -100),
    ], 'RSD')
    expect(g.total).toBe(400)
    expect(g.count).toBe(2)
  })

  it('treats a missing amount as zero rather than NaN', () => {
    const [g] = groupByMonth([row('a', '2026-09-01', null), row('b', '2026-09-02', 10)], 'RSD')
    expect(g.total).toBe(10)
    expect(g.count).toBe(2)
  })

  it('reads the figure for the currency asked for', () => {
    expect(amountOf({ amount_rsd: 586, amount_eur: 5 }, 'RSD')).toBe(586)
    expect(amountOf({ amount_rsd: 586, amount_eur: 5 }, 'EUR')).toBe(5)
    expect(amountOf({ amount_rsd: 586 }, 'EUR')).toBe(0)
    expect(amountOf({}, 'RSD')).toBe(0)
  })

  it('totals each month in EUR from amount_eur when the viewer reads EUR', () => {
    const groups = groupByMonth([
      { pl_date: '2026-09-01', amount_rsd: 11720, amount_eur: 100 },
      { pl_date: '2026-09-15', amount_rsd: 23460, amount_eur: 200 },
      { pl_date: '2026-08-15', amount_rsd: 5000, amount_eur: null },
    ], 'EUR')
    expect(groups.map(g => [g.key, g.count, g.total])).toEqual([
      ['2026-09', 2, 300],
      ['2026-08', 1, 0],
    ])
  })

  it('handles the owner case: one big node spread over a year', () => {
    const many: Row[] = []
    for (let m = 1; m <= 12; m++) {
      for (let i = 0; i < 95; i++) {
        many.push(row(`${m}-${i}`, `2026-${String(m).padStart(2, '0')}-0${(i % 9) + 1}`, 100))
      }
    }
    const groups = groupByMonth(many, 'RSD')
    expect(groups).toHaveLength(12)
    expect(groups[0].key).toBe('2026-12')
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(1140)
    // A month of a node this size is comfortably under the 300-row detail cap.
    expect(Math.max(...groups.map(g => g.count))).toBeLessThan(300)
  })
})

describe('reading what was typed into the filter box', () => {
  it('treats an empty box as no filter at all', () => {
    expect(parseFilter('')).toEqual(NO_FILTER)
    expect(parseFilter('   ')).toEqual(NO_FILTER)
  })

  it('reads a bare number as an amount', () => {
    const f = parseFilter('500')
    expect(f.kind).toBe('amount')
    expect(f.amount).toEqual({ op: '=', value: 500, tolerance: 0.5 })
  })

  it('tightens the tolerance to the precision typed', () => {
    expect(parseFilter('500.00').amount).toEqual({ op: '=', value: 500, tolerance: 0.005 })
    expect(parseFilter('500.5').amount).toEqual({ op: '=', value: 500.5, tolerance: 0.05 })
  })

  it('reads the four comparisons', () => {
    expect(parseFilter('>1000').amount).toMatchObject({ op: '>', value: 1000 })
    expect(parseFilter('>=1000').amount).toMatchObject({ op: '>=', value: 1000 })
    expect(parseFilter('<50').amount).toMatchObject({ op: '<', value: 50 })
    expect(parseFilter('<=50').amount).toMatchObject({ op: '<=', value: 50 })
    expect(parseFilter('=50').amount).toMatchObject({ op: '=', value: 50 })
  })

  it('ignores the thousands separators and a trailing currency code', () => {
    expect(parseFilter('1,200').amount).toMatchObject({ op: '=', value: 1200 })
    expect(parseFilter('1.200').amount).toMatchObject({ op: '=', value: 1200 })
    expect(parseFilter('> 1.200 RSD').amount).toMatchObject({ op: '>', value: 1200 })
    expect(parseFilter('1 200 eur').amount).toMatchObject({ op: '=', value: 1200 })
  })

  it('reads the app’s own Serbian notation back, decimals and all', () => {
    expect(parseFilter('1.234,56').amount).toEqual({ op: '=', value: 1234.56, tolerance: 0.005 })
    expect(parseFilter('1.234.567,8').amount).toMatchObject({ value: 1234567.8 })
    expect(parseFilter('500,00').amount).toEqual({ op: '=', value: 500, tolerance: 0.005 })
    expect(parseFilter('1,234.56').amount).toMatchObject({ value: 1234.56 })
  })

  it('no longer reads a dollar sign as part of an amount', () => {
    expect(parseFilter('$1,200').kind).toBe('text')
  })

  it('reads anything else as text, lower-cased', () => {
    expect(parseFilter('Slack')).toEqual({ kind: 'text', text: 'slack', amount: null })
    expect(parseFilter('  AWS  ')).toEqual({ kind: 'text', text: 'aws', amount: null })
  })

  it('reads a vendor whose name begins with digits as text', () => {
    // '500px' is not a number, so it falls through to text without needing
    // the escape. The escape is for a vendor literally called '500'.
    expect(parseFilter('500px').kind).toBe('text')
    expect(parseFilter('"500')).toEqual({ kind: 'text', text: '500', amount: null })
    expect(parseFilter('"500"')).toEqual({ kind: 'text', text: '500', amount: null })
  })

  it('does not read a lone quote as a search for nothing', () => {
    expect(parseFilter('"')).toEqual(NO_FILTER)
  })
})

describe('matching an amount', () => {
  const at = (raw: string) => parseFilter(raw).amount

  it('rounds to the precision typed', () => {
    expect(matchesAmount(500, at('500'))).toBe(true)
    expect(matchesAmount(500.49, at('500'))).toBe(true)
    expect(matchesAmount(499.51, at('500'))).toBe(true)
    expect(matchesAmount(501, at('500'))).toBe(false)
    expect(matchesAmount(500.01, at('500.00'))).toBe(false)
  })

  it('compares on the absolute value, so a stored sign cannot hide a row', () => {
    expect(matchesAmount(-500, at('500'))).toBe(true)
    expect(matchesAmount(-2000, at('>1000'))).toBe(true)
  })

  it('applies the comparisons at their boundary', () => {
    expect(matchesAmount(1000, at('>1000'))).toBe(false)
    expect(matchesAmount(1000, at('>=1000'))).toBe(true)
    expect(matchesAmount(50, at('<50'))).toBe(false)
    expect(matchesAmount(50, at('<=50'))).toBe(true)
  })

  it('treats a missing amount as zero rather than matching everything', () => {
    expect(matchesAmount(null, at('500'))).toBe(false)
    expect(matchesAmount(undefined, at('<1'))).toBe(true)
  })

  it('matches everything when there is no test', () => {
    expect(matchesAmount(12, null)).toBe(true)
  })
})

describe('matching text', () => {
  it('is a case-insensitive substring over every field offered', () => {
    expect(matchesText('slack', ['Slack Technologies'])).toBe(true)
    expect(matchesText('slack', [null, undefined, 'SLACK'])).toBe(true)
    expect(matchesText('slack', ['Zoom', 'nothing here'])).toBe(false)
  })

  it('matches everything on an empty needle', () => {
    expect(matchesText('', ['anything'])).toBe(true)
  })
})

describe('matching a row', () => {
  const r = row('a', '2026-09-14', 250, 'Software subscriptions')
  const detail = { title: 'Slack Technologies', note: 'renewed annually', path: 'Opex / Eng' }

  it('lets every row through when nothing is typed', () => {
    expect(rowMatches(r, undefined, NO_FILTER, 'RSD')).toBe(true)
  })

  it('searches the description without any detail having been fetched', () => {
    expect(rowMatches(r, undefined, parseFilter('subscriptions'), 'RSD')).toBe(true)
  })

  it('searches the vendor name, which only the fetched detail carries', () => {
    expect(rowMatches(r, undefined, parseFilter('slack'), 'RSD')).toBe(false)
    expect(rowMatches(r, detail, parseFilter('slack'), 'RSD')).toBe(true)
  })

  it('searches the note and the classification path too', () => {
    expect(rowMatches(r, detail, parseFilter('annually'), 'RSD')).toBe(true)
    expect(rowMatches(r, detail, parseFilter('eng'), 'RSD')).toBe(true)
  })

  it('never consults the detail for an amount filter', () => {
    const boom = () => { throw new Error('detail must not be needed to filter by amount') }
    expect(filterRows([r], parseFilter('250'), 'RSD', boom as any)).toEqual([r])
  })
})

describe('filtering a row set', () => {
  const rows = [
    row('a', '2026-09-14', 250, 'Software'),
    row('b', '2026-09-01', 1200, 'Hosting'),
    row('c', '2026-08-09', 250, 'Software'),
  ]
  const byId: Record<string, { title: string }> = {
    a: { title: 'Slack' }, b: { title: 'AWS' }, c: { title: 'Zoom' },
  }

  it('returns the same array when nothing is typed', () => {
    expect(filterRows(rows, NO_FILTER, 'RSD')).toBe(rows)
  })

  it('keeps month counts and totals honest after an amount filter', () => {
    const groups = groupByMonth(filterRows(rows, parseFilter('250'), 'RSD'), 'RSD')
    expect(groups.map(g => [g.key, g.count, g.total])).toEqual([
      ['2026-09', 1, 250],
      ['2026-08', 1, 250],
    ])
  })

  it('finds a vendor once its month detail has been loaded', () => {
    const detailFor = (r: Row) => byId[r.id]
    expect(filterRows(rows, parseFilter('slack'), 'RSD', detailFor).map(r => r.id)).toEqual(['a'])
  })

  it('finds nothing for a vendor whose month has not been loaded', () => {
    // Exactly why the component loads every month before claiming to search:
    // this is what a half-loaded text search silently looks like.
    const partial = (r: Row) => (r.id === 'b' ? byId[r.id] : undefined)
    expect(filterRows(rows, parseFilter('slack'), 'RSD', partial)).toEqual([])
    expect(filterRows(rows, parseFilter('aws'), 'RSD', partial).map(r => r.id)).toEqual(['b'])
  })
})

describe('summarising what matched', () => {
  it('counts only the months that still hold something', () => {
    const groups = groupByMonth([
      row('a', '2026-09-14', 250),
      row('b', '2026-09-01', 50),
      row('c', '2026-07-09', 100),
    ], 'RSD')
    expect(summarise(groups)).toEqual({ months: 2, count: 3, total: 400 })
  })

  it('reports nothing for an empty result', () => {
    expect(summarise([])).toEqual({ months: 0, count: 0, total: 0 })
  })

  it('does not count a month that filtered down to nothing', () => {
    const empty: ParsedFilter = parseFilter('99999')
    expect(summarise(groupByMonth(filterRows([row('a', '2026-09-14', 250)], empty, 'RSD'), 'RSD')))
      .toEqual({ months: 0, count: 0, total: 0 })
  })
})
