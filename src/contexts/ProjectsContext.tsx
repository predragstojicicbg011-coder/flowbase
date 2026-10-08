// ─── ProjectsContext ────────────────────────────────────────────────────────
//
// The projects, read once per signed-in user and shared — the same pattern as
// CompaniesContext. Pickers (<ProjectSelect>) read `activeProjects`; reports
// read `projects`, because a closed site still has history to show.
//
//   const { projects, activeProjects, loading, error, refresh } = useProjects()
//
// Call `refresh()` after the Projects page adds, edits or closes a project.
// Outside a provider the hook reads the table itself, so a dialog rendered
// alone (as the tests do) still gets its list.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useAuth } from './AuthContext'
import { fetchProjects, type Project } from '../services/projects'

export type { Project } from '../services/projects'

export interface ProjectsState {
  /** Every project the user can see, active or not, ordered by name. */
  projects: Project[]
  /** Only the active ones — what a picker offers. */
  activeProjects: Project[]
  loading: boolean
  /** Why the last read failed, or null. A silent failure reads as "no projects". */
  error: string | null
  refresh: () => Promise<void>
}

function useProjectsLoader(enabled: boolean, key: unknown): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setProjects(await fetchProjects(supabase))
      setError(null)
    } catch (e: any) {
      setProjects([])
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, key, refresh])

  const activeProjects = useMemo(() => projects.filter(p => p.active), [projects])

  return { projects, activeProjects, loading, error, refresh }
}

const ProjectsContext = createContext<ProjectsState | null>(null)

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const value = useProjectsLoader(!!user, user?.id)
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
}

export function useProjects(): ProjectsState {
  const shared = useContext(ProjectsContext)
  const own = useProjectsLoader(shared === null, null)
  return shared ?? own
}
