import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TimesheetPreliminaryPanel from './TimesheetPreliminaryPanel'
import { fundFor, type MonthFund } from '../services/payroll/holidays'
import { proposeFromCalendar } from '../services/payroll/preliminaryHours'
import {
  TEMPLATE_OFF_FUND, TEMPLATE_READ_ONLY, SAVE_TEMPLATE, REMOVE_TEMPLATE, onTemplateCount,
  FILL_IS_DIFFERENT, TEMPLATE_UNSAVED, TEMPLATE_PANEL_TITLE,
} from '../services/payroll/preliminaryText'

// Plain functions, not jest.fn(impl): resetMocks would strip an implementation.
const mockSaved: any[] = []
const mockRemoved: string[] = []
const mockFail: { current: string | null } = { current: null }
jest.mock('../services/payroll/preliminaryHoursStore', () => ({
  __esModule: true,
  savePreliminaryHours: async (_client: unknown, row: unknown) => {
    if (mockFail.current) throw new Error(mockFail.current)
    mockSaved.push(row)
  },
  removePreliminaryHours: async (_client: unknown, month: string) => { mockRemoved.push(month) },
  fetchPreliminaryHours: async () => null,
}))
jest.mock('../supabase', () => ({ __esModule: true, supabase: {} }))

// November 2026, one weekday holiday: 160 hours to work and 8 of holiday.
const FUND = fundFor('2026-11', [{ holiday_on: '2026-11-11', name: 'Praznik A', kind: 'state' }], null, null)

const panel = (over: Partial<React.ComponentProps<typeof TimesheetPreliminaryPanel>> = {}) =>
  render(<TimesheetPreliminaryPanel month="2026-11" fund={FUND} saved={null} canSave
    missing={3} onChanged={() => {}} {...over} />)

const saveButton = () => screen.getByRole('button', { name: SAVE_TEMPLATE })

beforeEach(() => { mockSaved.length = 0; mockRemoved.length = 0; mockFail.current = null })

describe('the preliminary hours panel', () => {
  it('is a titled region proposing the calendar\'s hours', () => {
    panel()
    expect(screen.getByRole('region', { name: TEMPLATE_PANEL_TITLE })).toBeInTheDocument()
    expect(screen.getByLabelText('Redovan rad')).toHaveValue('160')
    expect(screen.getByLabelText('Državni praznik')).toHaveValue('8')
    expect(screen.getByLabelText('Godišnji odmor')).toHaveValue('0')
    expect(saveButton()).toBeEnabled()
  })

  it('saves what is shown', async () => {
    const changed: string[] = []
    panel({ onChanged: () => changed.push('da') })
    fireEvent.change(screen.getByLabelText('Redovan rad'), { target: { value: '152' } })
    fireEvent.change(screen.getByLabelText('Godišnji odmor'), { target: { value: '8' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(changed).toEqual(['da']))
    expect(mockSaved[0].regular_hours).toBe(152)
    expect(mockSaved[0].vacation_hours).toBe(8)
    expect(mockSaved[0].holiday_hours).toBe(8)
    expect(mockSaved[0].month).toBe('2026-11-01')
  })

  it('a decimal comma is read as a decimal point', async () => {
    panel()
    fireEvent.change(screen.getByLabelText('Redovan rad'), { target: { value: '159,5' } })
    fireEvent.change(screen.getByLabelText('Godišnji odmor'), { target: { value: '0,5' } })
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())
    await waitFor(() => expect(mockSaved).toHaveLength(1))
    expect(mockSaved[0].regular_hours).toBe(159.5)
  })

  it('refuses to save hours that miss the fund, and says why', () => {
    panel()
    fireEvent.change(screen.getByLabelText('Državni praznik'), { target: { value: '0' } })
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(TEMPLATE_OFF_FUND(160, 168))).toBeInTheDocument()
  })

  it('a refused save is said', async () => {
    mockFail.current = 'Pretpostavljeni sati nisu sačuvani.'
    panel()
    fireEvent.click(saveButton())
    expect(await screen.findByText('Pretpostavljeni sati nisu sačuvani.')).toBeInTheDocument()
  })

  it('anybody but an administrator or the owner sees the hours and cannot save', () => {
    panel({ canSave: false, saved: proposeFromCalendar('2026-11', FUND) })
    expect(screen.getByText(TEMPLATE_READ_ONLY)).toBeInTheDocument()
    expect(screen.getByLabelText('Redovan rad')).toHaveAttribute('readonly')
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByRole('button', { name: REMOVE_TEMPLATE })).toBeNull()
  })

  it('a saved template the fund no longer matches is said, the proposal is loaded and saved in one click', async () => {
    const smaller: MonthFund = { ...FUND, monthHours: 160, holidayHours: 0, workableHours: 160 }
    panel({ fund: smaller, saved: proposeFromCalendar('2026-11', FUND) })
    expect(screen.getByText(TEMPLATE_OFF_FUND(168, 160))).toBeInTheDocument()
    expect(screen.queryByText(onTemplateCount(3))).toBeNull()
    expect(screen.getByLabelText('Redovan rad')).toHaveValue('160')
    expect(screen.getByLabelText('Državni praznik')).toHaveValue('0')
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())
    await waitFor(() => expect(mockSaved).toHaveLength(1))
    expect(mockSaved[0].regular_hours).toBe(160)
    expect(mockSaved[0].holiday_hours).toBe(0)
  })

  it('nothing saved: the unsaved sentence alone, nobody said to be on it', () => {
    panel()
    expect(screen.getByText(TEMPLATE_UNSAVED)).toBeInTheDocument()
    expect(screen.queryByText(onTemplateCount(3))).toBeNull()
    expect(screen.queryByRole('button', { name: REMOVE_TEMPLATE })).toBeNull()
    expect(screen.getByText(FILL_IS_DIFFERENT)).toBeInTheDocument()
  })

  it('a saved template that matches says how many are on it, and can be removed', async () => {
    const changed: string[] = []
    panel({ saved: proposeFromCalendar('2026-11', FUND), onChanged: () => changed.push('da') })
    expect(screen.getByText(onTemplateCount(3))).toBeInTheDocument()
    expect(onTemplateCount(3)).toBe('3 zaposlena nemaju evidenciju radnog vremena i obračunavaju se na ovim satima.')
    expect(onTemplateCount(1)).toBe('1 zaposleni nema evidenciju radnog vremena i obračunava se na ovim satima.')
    expect(screen.queryByText(TEMPLATE_UNSAVED)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: REMOVE_TEMPLATE }))
    await waitFor(() => expect(mockRemoved).toEqual(['2026-11']))
    expect(changed).toEqual(['da'])
  })
})
