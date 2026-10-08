import React from 'react'
import { render, screen } from '@testing-library/react'
import SystemCategoryNotice, { SYSTEM_CATEGORIES_HREF } from './SystemCategoryNotice'
import { PAYROLL_ROLES, CREDIT_ROLES } from '../services/systemCategories'
import { TEST_SYSTEM_CATEGORIES } from '../services/systemCategories.fixture'

describe('the notice before posting', () => {
  it('names every unset role and links to the settings tab', () => {
    render(<SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES} map={{}} />)
    const box = screen.getByTestId('system-category-notice')
    expect(box.textContent).toContain('Zarade ne mogu da se proknjiže.')
    expect(box.textContent).toContain('„Neto zarade“, „Porez na zarade“, „Doprinosi na teret zaposlenog“, „Doprinosi na teret poslodavca“')
    expect(box.textContent).toContain('Sistemske kategorije')
    expect(box.textContent).toContain('nisu podešene')
    expect(screen.getByRole('link').getAttribute('href')).toBe(SYSTEM_CATEGORIES_HREF)
    expect(SYSTEM_CATEGORIES_HREF).toBe('#/settings?tab=system')
  })

  it('speaks of one role in the singular', () => {
    const { credit_interest: _, ...map } = TEST_SYSTEM_CATEGORIES
    render(<SystemCategoryNotice what="Otplate kredita" roles={CREDIT_ROLES} map={map} />)
    const box = screen.getByTestId('system-category-notice')
    expect(box.textContent).toContain('Sistemska kategorija „Kamata na kredit“ nije podešena. Podesite je u')
  })

  it('says nothing when everything needed is set', () => {
    render(<SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES} map={TEST_SYSTEM_CATEGORIES} />)
    expect(screen.queryByTestId('system-category-notice')).not.toBeInTheDocument()
  })

  it('says nothing while the map is still loading', () => {
    render(<SystemCategoryNotice what="Zarade" roles={PAYROLL_ROLES} map={{}} loading />)
    expect(screen.queryByTestId('system-category-notice')).not.toBeInTheDocument()
  })
})
