import { summaryRows, entryRows, preambleRows, BRANCH_LEVELS } from './expenseExport'
import type { ComparedNode, PlEntry } from './expenseTree'
import { OVERHEAD_LABEL } from './projects'

const node = (over: Partial<ComparedNode> & { label: string; path: string[] }): ComparedNode => ({
  key: over.path.join('|'),
  depth: over.path.length - 1,
  amount: 0, count: 0, monthly: {}, children: [],
  priorAmount: 0, delta: 0, deltaPct: null,
  ...over,
} as ComparedNode)

const never = () => false

describe('summaryRows', () => {
  const tree = [
    node({
      label: 'Marketing', path: ['Marketing'], amount: 1000, priorAmount: 800, delta: 200, deltaPct: 25, count: 12,
      children: [
        node({ label: 'Office', path: ['Marketing', 'Office'], amount: 600, count: 7,
          children: [node({ label: 'Figma', path: ['Marketing', 'Office', 'Figma'], amount: 600, count: 7 })] }),
      ],
    }),
  ]

  it('writes a parent directly above its own children', () => {
    const rows = summaryRows(tree, 'department', 1000, never)
    expect(rows.map(r => r['Stavka'])).toEqual(['Marketing', 'Office', 'Figma'])
  })

  it('puts each level in the column it actually stands for, not a numbered slot', () => {
    const [, , leaf] = summaryRows(tree, 'department', 1000, never)
    expect(leaf['Sektor']).toBe('Marketing')
    expect(leaf['Podsektor']).toBe('Office')
    expect(leaf['Opis troška']).toBe('Figma')
    expect(leaf['P&L kategorija']).toBe('')
  })

  it('maps the same path to different columns in the other branch', () => {
    const [, , leaf] = summaryRows(tree, 'pl', 1000, never)
    expect(leaf['P&L kategorija']).toBe('Marketing')
    expect(leaf['P&L potkategorija']).toBe('Office')
    expect(leaf['Opis troška']).toBe('Figma')
    expect(leaf['Sektor']).toBe('')
  })

  it('carries a node its whole ancestry, so a row reads on its own', () => {
    const [, mid] = summaryRows(tree, 'department', 1000, never)
    expect(mid['Sektor']).toBe('Marketing')
    expect(mid['Podsektor']).toBe('Office')
  })

  it('reports the share of the total', () => {
    const [root, mid] = summaryRows(tree, 'department', 2000, never)
    expect(root['% od ukupnog']).toBe(50)
    expect(mid['% od ukupnog']).toBe(30)
  })

  it('does not divide by a zero total', () => {
    expect(summaryRows(tree, 'department', 0, never)[0]['% od ukupnog']).toBe(0)
  })

  it('leaves the change blank rather than writing a percentage it does not have', () => {
    const [, mid] = summaryRows(tree, 'department', 1000, never)
    expect(mid['Promena %']).toBe('')
  })

  it('lists a hidden line and marks it, rather than dropping it', () => {
    const rows = summaryRows(tree, 'department', 1000, k => k === 'Marketing|Office')
    expect(rows).toHaveLength(3)
    expect(rows.find(r => r['Stavka'] === 'Office')!['Isključeno']).toBe('da')
    expect(rows.find(r => r['Stavka'] === 'Marketing')!['Isključeno']).toBe('')
  })

  it('names the branch on every row, so two sheets can be concatenated', () => {
    expect(summaryRows(tree, 'pl', 1000, never).every(r => r['Grana'] === 'P&L')).toBe(true)
    expect(summaryRows(tree, 'department', 1000, never).every(r => r['Grana'] === 'Sektor')).toBe(true)
    expect(summaryRows(tree, 'project', 1000, never).every(r => r['Grana'] === 'Projekat')).toBe(true)
  })

  /**
   * The project branch puts its root — the project, or Opšti troškovi — in a
   * column of its own and breaks down by cost category underneath, so the
   * sheets can sit in one file without a level meaning two different things.
   */
  it('gives the project branch its own first column', () => {
    const [root, mid, leaf] = summaryRows(tree, 'project', 1000, never)
    expect(root['Projekat']).toBe('Marketing')
    expect(leaf['Projekat']).toBe('Marketing')
    expect(mid['P&L kategorija']).toBe('Office')
    expect(leaf['P&L potkategorija']).toBe('Figma')
    expect(leaf['Sektor']).toBe('')
  })

  it('numbers the level from one, not from zero', () => {
    const rows = summaryRows(tree, 'department', 1000, never)
    expect(rows.map(r => r['Nivo'])).toEqual([1, 2, 3])
  })
})

describe('entryRows', () => {
  const entries: PlEntry[] = [
    { id: 'a', pl_date: '2026-03-01', amount_rsd: 10100, amount_eur: 86.18, source: 'transaction',
      pl_category: 'Ops', pl_subcategory: 'Telecom', department: 'Admin',
      dept_subcategory: 'Office', expense_description: 'Telekom' },
    { id: 'b', pl_date: '2026-05-20', amount_rsd: 29300, source: 'invoice',
      pl_category: 'Ops', pl_subcategory: 'Telecom', department: 'Admin',
      dept_subcategory: 'Office', expense_description: 'Telekom' },
  ]
  const detail = new Map([
    ['a', { id: 'a', date: '2026-03-01', partner: 'Telekom Srbija', company: 'Test Company',
            documentNo: '', currency: 'RSD', amount: 10100, note: 'March', cfType: 'recurring' }],
  ])

  it('lists newest first, as every other list in the app does', () => {
    expect(entryRows(entries, detail).map(r => r['Datum'])).toEqual(['2026-05-20', '2026-03-01'])
  })

  it('repeats the full classification onto every row', () => {
    const r = entryRows(entries, detail)[1]
    expect(r['Sektor']).toBe('Admin')
    expect(r['Podsektor']).toBe('Office')
    expect(r['Opis troška']).toBe('Telekom')
    expect(r['P&L kategorija']).toBe('Ops')
  })

  it('names which table the row came from', () => {
    const rows = entryRows(entries, detail)
    expect(rows[0]['Izvor']).toBe('Faktura')
    expect(rows[1]['Izvor']).toBe('Transakcija')
  })

  it('keeps a row whose detail could not be read, so the sheet still ties', () => {
    const rows = entryRows(entries, detail)
    const missing = rows.find(r => r['Datum'] === '2026-05-20')!
    expect(missing.Partner).toBe('')
    expect(missing['Iznos RSD']).toBe(29300)
  })

  it('leaves the original amount blank rather than writing the book figure twice', () => {
    expect(entryRows(entries, detail).find(r => r.Partner === '')!['Iznos']).toBe('')
  })

  it('carries the original currency and amount when it has them', () => {
    const r = entryRows(entries, detail).find(r => r.Partner === 'Telekom Srbija')!
    expect(r['Valuta']).toBe('RSD')
    expect(r['Iznos']).toBe(10100)
    expect(r['Iznos RSD']).toBe(10100)
    expect(r['Iznos EUR']).toBe(86.18)
  })

  it('treats a missing amount_rsd as zero rather than writing nothing', () => {
    const rows = entryRows([{ ...entries[0], amount_rsd: null }], new Map())
    expect(rows[0]['Iznos RSD']).toBe(0)
  })

  it('leaves Amount EUR blank, not zero, where the row has no EUR figure yet', () => {
    const r = entryRows(entries, detail).find(r => r['Datum'] === '2026-05-20')!
    expect(r['Iznos EUR']).toBe('')
  })
})

describe('preambleRows', () => {
  const facts = {
    period: '2026 YTD', priorPeriod: '2025 YTD', company: 'All companies',
    total: 1000, prior: 800, excluded: 50, adjusted: 950,
    unassigned: 20, paretoLines: 7, entryCount: 1137,
    generatedAt: '2026-09-21 10:00',
    currency: 'RSD' as const,
  }

  it('leads with what the file is', () => {
    expect(preambleRows(facts)[0]).toEqual({ 'Polje': 'Izveštaj', 'Vrednost': 'P&L analiza' })
  })

  it('states the period and what it is compared with', () => {
    const v = (f: string) => preambleRows(facts).find(r => r['Polje'] === f)?.['Vrednost']
    expect(v('Period')).toBe('2026 YTD')
    expect(v('Upoređeno sa')).toBe('2025 YTD')
  })

  it('computes the change rather than asking the caller for it', () => {
    expect(preambleRows(facts).find(r => r['Polje'] === 'Promena (RSD)')?.['Vrednost']).toBe(200)
  })

  it('labels the totals with the currency they were summed in', () => {
    const fields = preambleRows({ ...facts, currency: 'EUR' }).map(r => r['Polje'])
    expect(fields).toContain('Ukupni troškovi (EUR)')
    expect(fields).toContain('Promena (EUR)')
    expect(fields.some(f => f.includes('RSD'))).toBe(false)
  })

  it('describes every sheet the workbook holds', () => {
    const fields = preambleRows(facts).map(r => r['Polje'])
    expect(fields).toEqual(expect.arrayContaining([
      'List: Po sektorima', 'List: Po P&L', 'List: Po projektima', 'List: Stavke',
    ]))
  })

  it('says hidden lines are present and marked, not missing', () => {
    const note = preambleRows(facts).find(r => r['Polje'] === 'Isključeni redovi')?.['Vrednost']
    expect(String(note)).toContain('označene')
  })
})

describe('BRANCH_LEVELS', () => {
  it('ends a filing branch in the expense description', () => {
    expect(BRANCH_LEVELS.pl).toEqual(['P&L kategorija', 'P&L potkategorija', 'Opis troška'])
    expect(BRANCH_LEVELS.department).toEqual(['Sektor', 'Podsektor', 'Opis troška'])
  })

  it('starts the project branch with the project', () => {
    expect(BRANCH_LEVELS.project).toEqual(['Projekat', 'P&L kategorija', 'P&L potkategorija'])
  })

  it('leaves the Project column blank on the other branches', () => {
    const t = [node({ label: 'X', path: ['X'] })]
    expect(summaryRows(t, 'pl', 1, never)[0]['Projekat']).toBe('')
    expect(summaryRows(t, 'department', 1, never)[0]['Projekat']).toBe('')
  })
})

describe('entryRows — the project column', () => {
  const base = { pl_date: '2026-03-01', pl_category: 'Ops', pl_subcategory: null, department: null,
    dept_subcategory: null, expense_description: null }

  it('names each row by its own project, and overhead when it has none', () => {
    const rows = entryRows([
      { ...base, id: 's1', amount_rsd: 600, project_id: 'p1', project_name: 'Zgrada A' },
      { ...base, id: 's2', amount_rsd: 400, project_id: null },
    ] as PlEntry[], new Map())
    expect(rows.map(r => r['Projekat']).sort()).toEqual(['Zgrada A', OVERHEAD_LABEL].sort())
  })
})
