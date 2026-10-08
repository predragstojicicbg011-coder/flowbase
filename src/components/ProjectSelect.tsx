// ─── ProjectSelect ──────────────────────────────────────────────────────────
//
// The one picker for `project_id`, on a document or on a split line. It is
// SearchableSelect with the projects as options and "Opšti troškovi (bez
// projekta)" as the pinned empty choice — which is null in the database.
//
//   <ProjectSelect value={projectId} onChange={setProjectId} />
//
// `value` and `onChange` speak the column's language: a project id or null.
// The '' ↔ null conversion happens here and nowhere else.
//
// Offered: the active projects (of `companyId`, when given). A row already
// pointing at a closed project still shows it, marked "(zatvoren)", so
// opening an old bill does not silently move it to overhead.

import React, { useMemo } from 'react'
import SearchableSelect, { type SelectOption } from './SearchableSelect'
import { useProjects } from '../contexts/ProjectsContext'
import {
  OVERHEAD_OPTION_LABEL, projectIdFromInput, projectIdToInput, projectLabel, type Project,
} from '../services/projects'

/**
 * The options for a picker: active projects, narrowed to a company when one
 * is given, plus the currently selected project if it is closed or belongs
 * elsewhere. The overhead choice is NOT in this list — SearchableSelect pins
 * it as the empty value.
 */
export function projectOptions(
  projects: readonly Project[], value: string | null | undefined, companyId?: string | null,
): SelectOption[] {
  const offered = projects.filter(p => p.active && (!companyId || p.company_id === companyId))
  const options = offered.map(p => ({ value: p.id, label: projectLabel(p) }))
  if (value && !offered.some(p => p.id === value)) {
    const current = projects.find(p => p.id === value)
    if (current) options.push({ value: current.id, label: `${projectLabel(current)} (zatvoren)` })
  }
  return options
}

export interface ProjectSelectProps {
  value: string | null | undefined
  onChange: (projectId: string | null) => void
  /** Narrow to one company's projects. */
  companyId?: string | null
  /** Override the list (tests, or a caller that already has it). Defaults to useProjects(). */
  projects?: readonly Project[]
  style?: React.CSSProperties
  disabled?: boolean
  title?: string
}

export default function ProjectSelect({
  value, onChange, companyId, projects, style, disabled, title,
}: ProjectSelectProps) {
  const ctx = useProjects()
  const list = projects ?? ctx.projects
  const options = useMemo(() => projectOptions(list, value, companyId), [list, value, companyId])

  return (
    <SearchableSelect
      value={projectIdToInput(value)}
      onChange={v => onChange(projectIdFromInput(v))}
      options={options}
      allLabel={OVERHEAD_OPTION_LABEL}
      searchPlaceholder="Pretraži projekte…"
      emptyMessage="Nema takvog projekta"
      style={style}
      disabled={disabled}
      title={title}
    />
  )
}
