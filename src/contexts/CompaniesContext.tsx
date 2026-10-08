import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from './AuthContext'
import { Company, fetchCompanies, pickDefaultCompany, showCompanyPicker } from '../services/companies'

export type { Company } from '../services/companies'

export interface CompaniesState {
  /** Every company, ordered by name. Empty until loaded. */
  companies: Company[]
  /** The company used when nobody has chosen one — the only one, usually. */
  defaultCompany: Company | null
  /** True only with two or more companies; pickers render on this alone. */
  showPicker: boolean
  loading: boolean
  /** Why the last read failed, or null. A silent failure reads as "no companies". */
  error: string | null
  /** Re-read the table, after Settings adds or renames a company. */
  refresh: () => Promise<void>
}

function useCompaniesLoader(enabled: boolean, key: unknown): CompaniesState {
  const [companies, setCompanies] = useState<Company[]>([])
  // True until the first read lands — including before there is a user to
  // read for, so no page acts on an empty list it has not been given yet.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setCompanies(await fetchCompanies())
      setError(null)
    } catch (e: any) {
      setCompanies([])
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, key, refresh])

  return {
    companies,
    defaultCompany: pickDefaultCompany(companies),
    showPicker: showCompanyPicker(companies),
    loading,
    error,
    refresh,
  }
}

const CompaniesContext = createContext<CompaniesState | null>(null)

/** Reads the companies once per signed-in user and shares them with the app. */
export function CompaniesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const value = useCompaniesLoader(!!user, user?.id)
  return <CompaniesContext.Provider value={value}>{children}</CompaniesContext.Provider>
}

/**
 * The companies, the default one, and whether to show a picker.
 *
 * Inside the provider this is the shared, already-loaded list. Outside it — a
 * component rendered on its own, as the tests do — it reads the table itself,
 * so a component never has to know which of the two it is in.
 */
export function useCompanies(): CompaniesState {
  const shared = useContext(CompaniesContext)
  const own = useCompaniesLoader(shared === null, null)
  return shared ?? own
}
