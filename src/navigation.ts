import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type Page =
  | 'dashboard' | 'transactions' | 'revenue' | 'cashflow'
  | 'budgeting' | 'reports' | 'expenses' | 'partners' | 'credits'
  | 'hr' | 'payroll' | 'settings'

// Redoslijed odgovara redoslijedu u sidebar-u.
export const PAGES: Page[] = [
  'dashboard', 'transactions', 'expenses', 'revenue', 'cashflow',
  'budgeting', 'reports', 'credits', 'hr', 'payroll', 'partners', 'settings',
]

export const pathFor = (p: Page): string => `/${p}`

export function pageFromPath(pathname: string): Page {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] as Page
  return PAGES.includes(seg) ? seg : 'dashboard'
}

/**
 * Zamjena za nekadasnji NavContext. Isti oblik API-ja ({ page, setPage }),
 * ali stanje sada zivi u URL-u — pa rade deep linkovi, Back dugme i refresh.
 */
export function useNav(): { page: Page; setPage: (p: Page) => void } {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const page = pageFromPath(pathname)
  const setPage = useCallback((p: Page) => navigate(pathFor(p)), [navigate])
  return { page, setPage }
}
