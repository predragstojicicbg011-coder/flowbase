import {
  OVERHEAD_LABEL, contractBookFigures, draftFromProject, emptyDraft, fetchProjects, normaliseProject,
  parseContractValue, projectIdFromInput, projectIdToInput, projectLabel, projectLabelById,
  projectProfitability, projectRow, validateProject,
  type PlEntryForProject, type Project, type ProjectDraft,
} from './projects'

jest.mock('./currencyService', () => {
  const actual = jest.requireActual('./currencyService')
  return {
    ...actual,
    // 117.2 RSD per EUR, 100 per USD, every day.
    getRatesForDate: async (date: string) => ({ date, eurRsdRate: 117.2, usdRsdRate: 100, source: 'test' }),
  }
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', company_id: 'c1', name: 'Novi Beograd A1', code: null, kind: 'construction',
  investor_partner_id: 'inv1', contract_value: null, contract_currency: null, contract_date: null,
  contract_value_rsd: null, contract_value_eur: null, active: true, note: null, ...over,
})

const draft = (over: Partial<ProjectDraft> = {}): ProjectDraft => ({
  ...emptyDraft(), name: 'Zemun B2', investor_partner_id: 'inv1', ...over,
})

describe('labels', () => {
  it('names a project by code and name, or by name alone', () => {
    expect(projectLabel(project())).toBe('Novi Beograd A1')
    expect(projectLabel(project({ code: ' NB-01 ' }))).toBe('NB-01 · Novi Beograd A1')
  })

  it('calls no project overhead', () => {
    expect(projectLabel(null)).toBe(OVERHEAD_LABEL)
    expect(projectLabelById([project()], null)).toBe('Opšti troškovi')
    expect(projectLabelById([project()], '')).toBe('Opšti troškovi')
  })

  it('never shows an unknown project as overhead', () => {
    expect(projectLabelById([project()], 'p1')).toBe('Novi Beograd A1')
    expect(projectLabelById([], 'gone', 'Stari objekat')).toBe('Stari objekat')
    expect(projectLabelById([], 'gone')).toBe('Nepoznat projekat')
  })

  it('maps the form empty value to null and back', () => {
    expect(projectIdFromInput('')).toBeNull()
    expect(projectIdFromInput('  ')).toBeNull()
    expect(projectIdFromInput(undefined)).toBeNull()
    expect(projectIdFromInput('p1')).toBe('p1')
    expect(projectIdToInput(null)).toBe('')
    expect(projectIdToInput('p1')).toBe('p1')
  })
})

describe('normaliseProject', () => {
  it('reads PostgREST numeric strings as numbers and fills defaults', () => {
    const p = normaliseProject({ id: 'x', company_id: 'c', name: 'N', kind: 'rental', contract_value: '1500.50',
      contract_currency: 'EUR', contract_value_rsd: '175858.6', contract_value_eur: '1500.5' })
    expect(p.contract_value).toBe(1500.5)
    expect(p.contract_value_rsd).toBe(175858.6)
    expect(p.kind).toBe('rental')
    expect(p.active).toBe(true)
    expect(p.code).toBeNull()
  })

  it('treats an unknown kind as construction and an unknown currency as none', () => {
    const p = normaliseProject({ id: 'x', name: 'N', kind: 'office', contract_currency: 'USD', active: false })
    expect(p.kind).toBe('construction')
    expect(p.contract_currency).toBeNull()
    expect(p.active).toBe(false)
  })
})

describe('fetchProjects', () => {
  const client = (pages: any[][], error: any = null) => {
    const calls: any[] = []
    let page = 0
    const builder: any = {
      select: (...a: any[]) => { calls.push(['select', ...a]); return builder },
      eq: (...a: any[]) => { calls.push(['eq', ...a]); return builder },
      order: (...a: any[]) => { calls.push(['order', ...a]); return builder },
      range: (...a: any[]) => {
        calls.push(['range', ...a])
        const data = pages[page++] || []
        return Promise.resolve(error ? { data: null, error } : { data, error: null })
      },
    }
    return { calls, client: { from: (t: string) => { calls.push(['from', t]); return builder } } }
  }

  it('narrows by company and to active ones when asked, ordered by name then id', async () => {
    const { client: c, calls } = client([[{ id: 'a', name: 'A', company_id: 'c1' }]])
    const rows = await fetchProjects(c, 'c1', { activeOnly: true })
    expect(rows.map(r => r.id)).toEqual(['a'])
    expect(calls).toContainEqual(['from', 'projects'])
    expect(calls).toContainEqual(['eq', 'company_id', 'c1'])
    expect(calls).toContainEqual(['eq', 'active', true])
    expect(calls.filter(x => x[0] === 'order').map(x => x[1])).toEqual(['name', 'id'])
  })

  it('says why in Serbian when the read fails', async () => {
    const { client: c } = client([], { message: 'permission denied' })
    await expect(fetchProjects(c)).rejects.toThrow('Projekti nisu učitani: permission denied')
  })
})

describe('parseContractValue', () => {
  it.each([
    ['', null],
    ['  ', null],
    ['1234567.89', 1234567.89],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1 234 567,89', 1234567.89],
    ['250000', 250000],
    ['12,5', 12.5],
  ])('%p → %p', (input, out) => {
    expect(parseContractValue(input)).toBe(out)
  })

  it('reports junk as NaN, not as null', () => {
    expect(parseContractValue('abc')).toBeNaN()
  })
})

describe('validateProject', () => {
  it('needs a name', () => {
    expect(validateProject(draft({ name: '  ' }), [])).toBe('Naziv projekta je obavezan.')
  })

  it('refuses the overhead label as a name, in any case', () => {
    expect(validateProject(draft({ name: ' opšti TROŠKOVI ' }), [])).toMatch(/rezervisan naziv/)
  })

  it('refuses a duplicate name in any case, but not the project itself', () => {
    const existing = [project({ id: 'p1', name: 'Zemun B2' })]
    expect(validateProject(draft({ name: 'zemun b2' }), existing)).toMatch(/već postoji/)
    expect(validateProject(draft({ id: 'p1', name: 'Zemun B2' }), existing)).toBeNull()
  })

  it('refuses a duplicate code', () => {
    const existing = [project({ id: 'p1', name: 'Drugi', code: 'NB-01' })]
    expect(validateProject(draft({ code: 'nb-01' }), existing)).toMatch(/Šifra/)
    expect(validateProject(draft({ code: '' }), existing)).toBeNull()
  })

  it('needs an investor on a construction site and not on a rental', () => {
    expect(validateProject(draft({ investor_partner_id: '' }), [])).toBe('Gradilište mora imati investitora.')
    expect(validateProject(draft({ kind: 'rental', investor_partner_id: '' }), [])).toBeNull()
  })

  it('accepts no contract value and refuses a bad or negative one', () => {
    expect(validateProject(draft({ contract_value: '' }), [])).toBeNull()
    expect(validateProject(draft({ contract_value: 'x' }), [])).toMatch(/ispravan broj/)
    expect(validateProject(draft({ contract_value: '-5' }), [])).toMatch(/negativna/)
  })

  it('refuses a malformed date', () => {
    expect(validateProject(draft({ contract_date: '08.10.2026' }), [])).toMatch(/Datum/)
    expect(validateProject(draft({ contract_date: '2026-10-08' }), [])).toBeNull()
  })
})

describe('contract value', () => {
  it('books a EUR contract at the day\'s rate, exactly in EUR', async () => {
    const b = await contractBookFigures(100000, 'EUR', '2026-10-08')
    expect(b).toEqual({ contract_date: '2026-10-08', contract_value_rsd: 11720000, contract_value_eur: 100000 })
  })

  it('books a RSD contract with its EUR beside it', async () => {
    const b = await contractBookFigures(1172000, 'RSD', '2026-10-08')
    expect(b.contract_value_rsd).toBe(1172000)
    expect(b.contract_value_eur).toBe(10000)
  })

  it('writes the book figures with the value, and nothing without one', () => {
    const book = { contract_date: '2026-10-08', contract_value_rsd: 11720000, contract_value_eur: 100000 }
    const row = projectRow(draft({ contract_value: '100.000,00', contract_currency: 'EUR', code: ' ', note: '  ' }), 'c1', book)
    expect(row).toMatchObject({
      company_id: 'c1', name: 'Zemun B2', code: null, kind: 'construction', investor_partner_id: 'inv1',
      contract_value: 100000, contract_currency: 'EUR', contract_date: '2026-10-08',
      contract_value_rsd: 11720000, contract_value_eur: 100000, active: true, note: null,
    })

    const bare = projectRow(draft({ kind: 'rental', investor_partner_id: '' }), 'c1', null)
    expect(bare).toMatchObject({
      investor_partner_id: null, contract_value: null, contract_currency: null,
      contract_value_rsd: null, contract_value_eur: null,
    })
  })

  it('refuses to write a value that was not converted', () => {
    expect(() => projectRow(draft({ contract_value: '10' }), 'c1', null)).toThrow(/preračunata/)
  })

  it('round-trips a stored project through the form', () => {
    const p = project({ code: 'Z2', contract_value: 2500.5, contract_currency: 'EUR', contract_date: '2026-01-15', note: 'n' })
    expect(draftFromProject(p)).toEqual({
      id: 'p1', name: 'Novi Beograd A1', code: 'Z2', kind: 'construction', investor_partner_id: 'inv1',
      contract_value: '2500.5', contract_currency: 'EUR', contract_date: '2026-01-15', active: true, note: 'n',
    })
  })
})

describe('projectProfitability', () => {
  const projects = [
    project({ id: 'a', name: 'Alfa' }),
    project({ id: 'b', name: 'Beta', code: 'B' }),
    project({ id: 'c', name: 'Gama' }),
  ]
  const row = (project_id: string | null, tx_type: string, rsd: number | string | null, eur: number | string | null, project_name?: string): PlEntryForProject =>
    ({ project_id, tx_type, amount_rsd: rsd, amount_eur: eur, project_name })

  const rows: PlEntryForProject[] = [
    row('a', 'revenue', 1000000, 8532.42),
    row('a', 'expense', 600000, 5119.45),
    row('a', 'expense', '150000', '1279.86'),       // PostgREST strings
    row('b', 'expense', 200000, 1706.48),            // all cost, no revenue
    row(null, 'expense', 300000, 2559.73),           // overhead
    row(null, 'revenue', 50000, 426.62),             // overhead income (interest)
    row('a', 'revenue', -100000, -853.24),           // a credit note
    row('a', 'transfer', 999, 9),                    // not P&L — ignored
  ]

  it('computes revenue, direct cost and margin per project in RSD', () => {
    const r = projectProfitability(rows, 'RSD', projects)
    const a = r.projects.find(p => p.projectId === 'a')!
    expect(a).toMatchObject({ label: 'Alfa', revenue: 900000, directCost: 750000, margin: 150000, marginPct: 16.7 })
    const b = r.projects.find(p => p.projectId === 'b')!
    expect(b).toMatchObject({ label: 'B · Beta', revenue: 0, directCost: 200000, margin: -200000, marginPct: null })
  })

  it('reads the EUR column when EUR is the display currency', () => {
    const a = projectProfitability(rows, 'EUR', projects).projects.find(p => p.projectId === 'a')!
    expect(a.revenue).toBe(7679.18)
    expect(a.directCost).toBe(6399.31)
    expect(a.margin).toBe(1279.87)
  })

  it('keeps overhead on its own row and out of every project', () => {
    const r = projectProfitability(rows, 'RSD', projects)
    expect(r.overhead).toMatchObject({ projectId: null, label: 'Opšti troškovi', revenue: 50000, directCost: 300000, margin: -250000 })
    expect(r.total).toMatchObject({ revenue: 950000, directCost: 1250000, margin: -300000 })
    const sum = r.projects.reduce((s, p) => s + p.margin, 0) + r.overhead.margin
    expect(sum).toBe(r.total.margin)
  })

  it('lists every project, booked or not, in the order given', () => {
    const r = projectProfitability(rows, 'RSD', projects)
    expect(r.projects.map(p => p.projectId)).toEqual(['a', 'b', 'c'])
    expect(r.projects[2]).toMatchObject({ revenue: 0, directCost: 0, margin: 0, marginPct: null })
  })

  it('adds a project the rows name but the list does not, labelled from the row', () => {
    const r = projectProfitability([row('x', 'expense', 10, 0.09, 'Zatvoreno gradilište')], 'RSD', projects)
    expect(r.projects.map(p => p.projectId)).toEqual(['a', 'b', 'c', 'x'])
    expect(r.projects[3]).toMatchObject({ label: 'Zatvoreno gradilište', directCost: 10 })
  })

  it('treats an empty project id as overhead', () => {
    const r = projectProfitability([row('', 'expense', 10, 0.09)], 'RSD', [])
    expect(r.projects).toEqual([])
    expect(r.overhead.directCost).toBe(10)
  })

  it('counts rows with no figure in the chosen currency instead of hiding them', () => {
    const r = projectProfitability([row('a', 'expense', 100, null), row(null, 'revenue', 5, null)], 'EUR', projects)
    expect(r.projects[0].unconverted).toBe(1)
    expect(r.projects[0].directCost).toBe(0)
    expect(r.overhead.unconverted).toBe(1)
    expect(r.total.unconverted).toBe(2)
  })

  it('works with nothing at all', () => {
    const r = projectProfitability([], 'RSD')
    expect(r.projects).toEqual([])
    expect(r.total).toMatchObject({ revenue: 0, directCost: 0, margin: 0, marginPct: null, unconverted: 0 })
  })

  it('rounds to the cent after summing, not before', () => {
    const r = projectProfitability([row('a', 'revenue', 0.1, 0), row('a', 'revenue', 0.2, 0)], 'RSD', projects)
    expect(r.projects[0].revenue).toBe(0.3)
  })
})
