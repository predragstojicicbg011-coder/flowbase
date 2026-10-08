// ─── SystemCategoriesContext ────────────────────────────────────────────────
//
// The system categories (see services/systemCategories.ts), read once per
// signed-in user and shared — the same pattern as ProjectsContext.
//
//   const { map, loading, error, refresh } = useSystemCategories()
//
// Settings → Sistemske kategorije calls `refresh()` after a save. Outside a
// provider the hook reads the table itself, so a dialog rendered alone (as
// the tests do) still gets its map.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useAuth } from './AuthContext'
import { fetchSystemCategories, type SystemCategoryMap } from '../services/systemCategories'

export interface SystemCategoriesState {
  map: SystemCategoryMap
  loading: boolean
  /** Why the last read failed, or null. */
  error: string | null
  refresh: () => Promise<void>
}

function useSystemCategoriesLoader(enabled: boolean, key: unknown): SystemCategoriesState {
  const [map, setMap] = useState<SystemCategoryMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setMap(await fetchSystemCategories(supabase))
      setError(null)
    } catch (e: any) {
      setMap({})
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, key, refresh])

  return { map, loading, error, refresh }
}

const SystemCategoriesContext = createContext<SystemCategoriesState | null>(null)

export function SystemCategoriesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const value = useSystemCategoriesLoader(!!user, user?.id)
  return <SystemCategoriesContext.Provider value={value}>{children}</SystemCategoriesContext.Provider>
}

export function useSystemCategories(): SystemCategoriesState {
  const shared = useContext(SystemCategoriesContext)
  const own = useSystemCategoriesLoader(shared === null, null)
  return shared ?? own
}
