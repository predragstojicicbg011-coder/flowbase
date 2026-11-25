import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PartnerDialog from './PartnerDialog'

// Jedan PIB, jedan partner. Drugi partner na PIB-u koji već postoji deli
// dokumente dobavljača na dva; forma to odbija i imenuje partnera koji ga
// ima. Sva imena i brojevi ovde su izmišljeni.

const mockState = {
  partners: [] as any[],
  inserted: [] as any[],
  updated: [] as any[],
  lookups: [] as { column: string; pattern: string; ordered: string; ranges: [number, number][] }[],
  readError: null as string | null,
}

/** Zamena koja na `like` odgovara kao Postgres (`%` je bilo koji niz
 *  znakova) i stranica sa `range` do granice od 1000 redova. */
function mockQuery(table: string) {
  let lookup: { column: string; pattern: string; ordered: string; ranges: [number, number][] } | null = null
  let excluded = ''
  const q: any = {}
  q.select = () => q
  q.eq = () => q
  q.like = (c: string, p: string) => {
    lookup = mockState.lookups.find(l => l.column === c && l.pattern === p) || { column: c, pattern: p, ordered: '', ranges: [] }
    if (!mockState.lookups.includes(lookup)) mockState.lookups.push(lookup)
    return q
  }
  q.neq = (_c: string, v: string) => { excluded = v; return q }
  q.order = (c: string) => { if (lookup) lookup.ordered = c; return q }
  q.range = (from: number, to: number) => {
    lookup!.ranges.push([from, to])
    if (mockState.readError) return Promise.resolve({ data: null, error: { message: mockState.readError } })
    // Obrazac su samo cifre i `%`, pa u njemu nema šta da se escapuje.
    const re = new RegExp('^' + lookup!.pattern.split('%').join('.*') + '$')
    const all = table === 'partners'
      ? mockState.partners.filter(p => p.id !== excluded && re.test(String(p[lookup!.column] ?? '')))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
      : []
    return Promise.resolve({ data: all.slice(from, to + 1), error: null })
  }
  q.insert = (payload: any) => {
    mockState.inserted.push(payload)
    const ins: any = {}
    ins.select = () => ins
    ins.single = async () => ({ data: { id: 'new', ...payload }, error: null })
    return ins
  }
  q.update = (payload: any) => {
    mockState.updated.push(payload)
    return { eq: () => Promise.resolve({ data: null, error: null }) }
  }
  q.then = (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return q
}

jest.mock('../supabase', () => ({
  supabase: { from: (t: string) => mockQuery(t), functions: { invoke: async () => ({ data: null, error: null }) } },
}))

const REFUSED = 'Ništa nije sačuvano: ovaj PIB već ima partner Alfa Doo. Koristite tog partnera ili ispravite broj.'
const save = () => fireEvent.click(screen.getByText(/Sačuvaj partnera|Sačuvaj izmene/))

beforeEach(() => {
  mockState.partners = [
    { id: 'p-a', name: 'Alfa Doo', tax_id: 'RS100000001', registration_number: '20000001' },
    { id: 'p-a2', name: 'Alfa Doo Beograd', tax_id: '100000001', registration_number: null },
    { id: 'p-x', name: 'Duži Broj Doo', tax_id: '1100000002', registration_number: null },
  ]
  mockState.inserted = []
  mockState.updated = []
  mockState.lookups = []
  mockState.readError = null
})

describe('PIB koji već ima drugi partner', () => {
  it('odbija novog partnera na njemu, imenuje partnera, poredi po ciframa', async () => {
    mockState.partners = mockState.partners.filter(p => p.id !== 'p-a2')
    render(<PartnerDialog initialName="Alfa" initialTaxId="100 000 001" onClose={() => {}} onSaved={() => {}} />)
    save()
    expect(await screen.findByText(REFUSED)).toBeInTheDocument()
    expect(mockState.inserted).toHaveLength(0)
  })

  it('ostaje odbijeno i posle povratka na formu i ponovnog čuvanja', async () => {
    mockState.partners = mockState.partners.filter(p => p.id !== 'p-a2')
    render(<PartnerDialog initialName="Alfa" initialTaxId="100000001" onClose={() => {}} onSaved={() => {}} />)
    save()
    fireEvent.click(await screen.findByText('Nazad na formu'))
    expect(screen.queryByText(REFUSED)).toBeNull()
    save()
    expect(await screen.findByText(REFUSED)).toBeInTheDocument()
    expect(mockState.inserted).toHaveLength(0)
  })

  it('odbija izmenu koja partnera premešta na njega', async () => {
    mockState.partners = mockState.partners.filter(p => p.id !== 'p-a2')
    const partner = { id: 'p-g', name: 'Gama Doo', tax_id: '100000005', registration_number: null }
    render(<PartnerDialog partner={partner} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('100000005'), { target: { value: '100000001' } })
    save()
    expect(await screen.findByText(REFUSED)).toBeInTheDocument()
    expect(mockState.updated).toHaveLength(0)
  })

  it('odbija novog na matičnom broju koji ima drugi partner', async () => {
    render(<PartnerDialog initialName="Alfa" initialRegistrationNumber="20000001" onClose={() => {}} onSaved={() => {}} />)
    save()
    expect(await screen.findByText('Ništa nije sačuvano: ovaj matični broj već ima partner Alfa Doo. Koristite tog partnera ili ispravite broj.')).toBeInTheDocument()
    expect(mockState.inserted).toHaveLength(0)
  })
})

describe('čitanje radi duplikata', () => {
  it('ga nalazi kako god da su cifre razmaknute ili sa prefiksom', async () => {
    mockState.partners = [{ id: 'p-s', name: 'Razmak Doo', tax_id: 'RS 100 000 001', registration_number: null }]
    render(<PartnerDialog initialName="Alfa" initialTaxId="100000001" onClose={() => {}} onSaved={() => {}} />)
    save()
    expect(await screen.findByText('Ništa nije sačuvano: ovaj PIB već ima partner Razmak Doo. Koristite tog partnera ili ispravite broj.')).toBeInTheDocument()
  })

  /** Prozor od prvih pedeset, bez redosleda, mogao bi da izostavi pravog. */
  it('čita svaku stranu kandidata, stalnim redosledom, pa pravi ne može da ispadne', async () => {
    mockState.partners = Array.from({ length: 1200 }, (_, i) => ({
      id: `p-${String(i).padStart(5, '0')}`, name: `Šum ${i}`, tax_id: `1x0x0x0x0x0x0x0x1x${i}`, registration_number: null,
    }))
    mockState.partners.push({ id: 'p-zz', name: 'Alfa Doo', tax_id: '100000001', registration_number: null })
    render(<PartnerDialog initialName="Alfa" initialTaxId="100000001" onClose={() => {}} onSaved={() => {}} />)
    save()
    expect(await screen.findByText(REFUSED)).toBeInTheDocument()
    const l = mockState.lookups.find(x => x.column === 'tax_id')!
    expect(l.pattern).toBe('%1%0%0%0%0%0%0%0%1%')
    expect(l.ordered).toBe('id')
    expect(l.ranges).toEqual([[0, 999], [1000, 1999]])
  })

  it('čuva i kad čitanje ne uspe, i kaže da nije provereno', async () => {
    mockState.readError = 'timeout'
    render(<PartnerDialog initialName="Alfa" initialTaxId="100000001" onClose={() => {}} onSaved={() => {}} />)
    save()
    expect(await screen.findByText('Sačuvano bez provere da li drugi partner ima isti PIB ili matični broj: provera nije mogla da se pročita.')).toBeInTheDocument()
    expect(mockState.inserted).toHaveLength(1)
  })
})

describe('šta nije duplikat', () => {
  /** Knjige već imaju takve parove; odbijanje svake izmene bilo koje
   *  polovine ne bi rasturilo nijedan. */
  it('partner iz postojećeg para može da se menja kad mu PIB ostane isti', async () => {
    const partner = mockState.partners[1]
    render(<PartnerDialog partner={partner} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('Alfa Doo Beograd'), { target: { value: 'Alfa Doo Novi Sad' } })
    save()
    await waitFor(() => expect(mockState.updated).toHaveLength(1))
    expect(mockState.lookups).toHaveLength(0)
  })

  it('ne vara ga duži broj koji sadrži PIB', async () => {
    render(<PartnerDialog initialName="Beta" initialTaxId="100000002" onClose={() => {}} onSaved={() => {}} />)
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ name: 'Beta', tax_id: '100000002' })
  })

  it('čuva novog partnera sa adresom i gradom sa kojima je otvoren', async () => {
    render(<PartnerDialog initialName="Delta" initialTaxId="100000004" initialAddress="Test ulica 1" initialCity="Testgrad" onClose={() => {}} onSaved={() => {}} />)
    save()
    await waitFor(() => expect(mockState.inserted).toHaveLength(1))
    expect(mockState.inserted[0]).toMatchObject({ tax_id: '100000004', address: 'Test ulica 1', city: 'Testgrad' })
  })
})
