import { bookStillValid } from './ProjectDialog'
import { draftFromProject, type Project } from '../services/projects'

jest.mock('../supabase', () => ({ supabase: {} }))

const stored: Project = {
  id: 'p1', company_id: 'c1', name: 'Zemun', code: null, kind: 'construction', investor_partner_id: 'i',
  contract_value: 100000, contract_currency: 'EUR', contract_date: '2026-03-01',
  contract_value_rsd: 11720000, contract_value_eur: 100000, active: true, note: null,
}

describe('bookStillValid — a re-save does not re-book the contract', () => {
  it('keeps the stored figures when value, currency and date are unchanged', () => {
    expect(bookStillValid(stored, { ...draftFromProject(stored), note: 'samo napomena' })).toBe(true)
  })

  it('keeps them when the date field was cleared', () => {
    expect(bookStillValid(stored, { ...draftFromProject(stored), contract_date: '' })).toBe(true)
  })

  it('re-books when the value, currency or date changes', () => {
    const d = draftFromProject(stored)
    expect(bookStillValid(stored, { ...d, contract_value: '120000' })).toBe(false)
    expect(bookStillValid(stored, { ...d, contract_currency: 'RSD' })).toBe(false)
    expect(bookStillValid(stored, { ...d, contract_date: '2026-04-01' })).toBe(false)
  })

  it('books a new project, and one that had no figures', () => {
    expect(bookStillValid(null, draftFromProject(stored))).toBe(false)
    expect(bookStillValid({ ...stored, contract_value_rsd: null }, draftFromProject(stored))).toBe(false)
  })
})
