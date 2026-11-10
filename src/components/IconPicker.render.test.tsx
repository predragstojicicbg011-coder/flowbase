import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import IconPicker, { TEMPLATE_ICONS, iconLabel } from './IconPicker'

// A template's icon is picked from a set, so the list of templates is not a
// column of identical lightning bolts.

describe('the icon picker', () => {
  it('offers a varied set and marks the chosen one', () => {
    render(<IconPicker value="🏦" onChange={() => {}} />)
    expect(TEMPLATE_ICONS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(TEMPLATE_ICONS).size).toBe(TEMPLATE_ICONS.length)
    expect(screen.getByRole('button', { name: 'Ikonica 🏦' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Ikonica ⚡' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('hands back the icon that was clicked', () => {
    const picked = jest.fn()
    render(<IconPicker value="⚡" onChange={picked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ikonica ⛽' }))
    expect(picked).toHaveBeenCalledWith('⛽')
  })

  it('keeps an icon a template already has even when it is not in the set', () => {
    render(<IconPicker value="🦄" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Ikonica 🦄' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the description of an icon', () => {
  it('names the chosen icon right under the set, and each icon on hover', () => {
    render(<IconPicker value="⛽" onChange={() => {}} />)
    expect(screen.getByText('Izabrano: ⛽ Gorivo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ikonica 🏦' })).toHaveAttribute('title', 'Banka i provizije')
  })

  it('every icon in the set has a description of its own', () => {
    expect(TEMPLATE_ICONS.every(i => !!iconLabel(i))).toBe(true)
    expect(new Set(TEMPLATE_ICONS.map(iconLabel)).size).toBe(TEMPLATE_ICONS.length)
  })

  it('an icon from outside the set is shown with no made-up name', () => {
    render(<IconPicker value="🦄" onChange={() => {}} />)
    expect(screen.getByText('Izabrano: 🦄')).toBeInTheDocument()
  })
})
