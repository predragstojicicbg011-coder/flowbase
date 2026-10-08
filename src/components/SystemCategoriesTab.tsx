import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import { settingsStyles as s } from '../pages/Settings'
import {
  SYSTEM_ROLES, ROLE_GROUP_LABEL, FIELD_LABEL, EMPTY_CLASSIFICATION,
  isRoleSet, saveSystemCategory,
  type Classification, type ClassField, type RoleGroup, type SystemRole, type SystemRoleDef,
} from '../services/systemCategories'
import { countOf } from '../utils/plural'

// ── Sistemske kategorije ────────────────────────────────────────────────────
// Where the app books what it books on its own — payroll, credit instalments,
// the two lines the cash flow singles out. One row per role, each with the
// pickers that role fills, over the owner's own P&L structure (the other
// tabs). An unset role is flagged here, and every posting that needs it is
// refused until it is set. See services/systemCategories.ts.

interface Named { id: string; name: string }
interface Structure {
  categories: Named[]
  subcategories: (Named & { category_id: string | null })[]
  departments: Named[]
  deptSubcategories: (Named & { department_id: string | null })[]
  descriptions: (Named & { dept_subcategory_id: string | null })[]
}

const EMPTY_STRUCTURE: Structure = {
  categories: [], subcategories: [], departments: [], deptSubcategories: [], descriptions: [],
}

const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, 'sr'))

/** What each field of a draft may be, given what is chosen above it. */
export function optionsFor(field: ClassField, draft: Classification, st: Structure, def: SystemRoleDef): string[] {
  switch (field) {
    case 'pl_category':
      return st.categories.map(c => c.name)
    case 'pl_subcategory': {
      const cats = st.categories.filter(c => c.name === draft.pl_category).map(c => c.id)
      return uniq(st.subcategories.filter(x => x.category_id && cats.includes(x.category_id)).map(x => x.name))
    }
    case 'department':
      return st.departments.map(d => d.name)
    case 'dept_subcategory': {
      // A role that does not choose a sector (the salary podsektor) is offered
      // every podsektor name: the person's sector decides which one it is.
      if (!def.fields.includes('department')) return uniq(st.deptSubcategories.map(x => x.name))
      const deps = st.departments.filter(d => d.name === draft.department).map(d => d.id)
      return uniq(st.deptSubcategories.filter(x => x.department_id && deps.includes(x.department_id)).map(x => x.name))
    }
    case 'expense_description': {
      const deps = st.departments.filter(d => d.name === draft.department).map(d => d.id)
      const subs = st.deptSubcategories
        .filter(x => x.name === draft.dept_subcategory && (!def.fields.includes('department')
          || (x.department_id && deps.includes(x.department_id))))
        .map(x => x.id)
      return uniq(st.descriptions.filter(x => x.dept_subcategory_id && subs.includes(x.dept_subcategory_id)).map(x => x.name))
    }
  }
}

/** Fields cleared when `field` changes — the ones that hang below it. */
const CHILDREN: Record<ClassField, ClassField[]> = {
  pl_category: ['pl_subcategory'],
  pl_subcategory: [],
  department: ['dept_subcategory', 'expense_description'],
  dept_subcategory: ['expense_description'],
  expense_description: [],
}

type Status = 'set' | 'unset' | 'stale'

export default function SystemCategoriesTab({ canEdit }: { canEdit: boolean }) {
  const { defaultCompany } = useCompanies()
  const system = useSystemCategories()
  const [structure, setStructure] = useState<Structure>(EMPTY_STRUCTURE)
  const [loading, setLoading] = useState(true)
  /** Only the roles somebody has changed and not saved; the rest show what is saved. */
  const [drafts, setDrafts] = useState<Partial<Record<SystemRole, Classification>>>({})
  const [saving, setSaving] = useState<SystemRole | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [c, sc, d, ds, ed] = await Promise.all([
      supabase.from('pl_categories').select('id,name,sort_order').order('sort_order'),
      supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
      supabase.from('departments').select('id,name,sort_order').order('sort_order'),
      supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
      supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
    ])
    const failed = [c, sc, d, ds, ed].find(r => r?.error)
    if (failed) setError(`P&L struktura nije učitana: ${failed.error?.message}`)
    setStructure({
      categories: c?.data || [], subcategories: sc?.data || [], departments: d?.data || [],
      deptSubcategories: ds?.data || [], descriptions: ed?.data || [],
    })
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  /** What a role's pickers show: the unsaved change, else what is saved. */
  const current = (role: SystemRole): Classification =>
    drafts[role] ?? { ...EMPTY_CLASSIFICATION, ...(system.map[role] || {}) }

  const statusOf = useCallback((def: SystemRoleDef): Status => {
    if (!isRoleSet(def.role, system.map)) return 'unset'
    const saved = system.map[def.role]!
    const exists = def.fields.every(f => optionsFor(f, saved, structure, def).includes((saved[f] || '').trim()))
    return exists ? 'set' : 'stale'
  }, [system.map, structure])

  const unsetCount = useMemo(
    () => SYSTEM_ROLES.filter(r => statusOf(r) !== 'set').length, [statusOf])

  const patch = (role: SystemRole, field: ClassField, value: string) => {
    setDrafts(prev => {
      const cur = { ...(prev[role] ?? { ...EMPTY_CLASSIFICATION, ...(system.map[role] || {}) }) }
      cur[field] = value || null
      for (const child of CHILDREN[field]) cur[child] = null
      return { ...prev, [role]: cur }
    })
    setNotice(''); setError('')
  }

  const save = async (def: SystemRoleDef) => {
    if (!canEdit) return
    const companyId = defaultCompany?.id
    if (!companyId) { setError('Nema firme kojoj bi se kategorija sačuvala.'); return }
    const draft = current(def.role)
    const empty = def.fields.filter(f => !(draft[f] || '').trim())
    if (empty.length > 0) {
      setError(`„${def.label}“: izaberite ${empty.map(f => FIELD_LABEL[f].toLowerCase()).join(', ')}.`)
      return
    }
    setSaving(def.role); setError(''); setNotice('')
    try {
      await saveSystemCategory(supabase, companyId, def.role, draft)
      await system.refresh()
      setDrafts(prev => { const next = { ...prev }; delete next[def.role]; return next })
      setNotice(`„${def.label}“ je sačuvana.`)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
    setSaving(null)
  }

  const groups = (Object.keys(ROLE_GROUP_LABEL) as RoleGroup[])
    .map(g => ({ group: g, roles: SYSTEM_ROLES.filter(r => r.group === g) }))

  return (
    <>
      {!canEdit && <div style={s.readOnlyBanner}>👁 Samo pregled — sistemske kategorije mogu da menjaju samo administratori.</div>}

      <div style={{ ...s.readOnlyBanner, background: 'rgba(78,168,255,0.08)', border: '1px solid rgba(78,168,255,0.25)', color: '#9CC7F2' }}>
        Ovde se bira gde aplikacija sama knjiži: zarade, otplate kredita i dve stavke novčanog toka.
        Bira se iz vaše P&L strukture (prethodni tabovi). Dok kategorija nije podešena, knjiženje
        koje je koristi se odbija — ništa se ne knjiži pod praznim ili pogrešnim nazivom.
        {unsetCount > 0 && !loading && !system.loading && (
          <> <b>{countOf(unsetCount, 'kategorija još nije podešena', 'kategorije još nisu podešene', 'kategorija još nije podešeno')}.</b></>
        )}
      </div>

      {(error || system.error) && (
        <div role="alert" style={{ ...s.readOnlyBanner, background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.3)', color: '#FF5B5A' }}>
          {error || system.error}
        </div>
      )}
      {notice && (
        <div style={{ ...s.readOnlyBanner, background: 'rgba(0,212,126,0.10)', border: '1px solid rgba(0,212,126,0.3)', color: '#00D47E' }}>
          {notice}
        </div>
      )}

      {loading || system.loading ? <div style={s.loading}>Učitavanje…</div> : groups.map(({ group, roles }) => (
        <div key={group} style={{ ...s.colPanel, marginBottom: '16px' }}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>{ROLE_GROUP_LABEL[group]}</div>
            <span style={s.colCount}>{roles.length}</span>
          </div>
          {roles.map(def => {
            const draft = current(def.role)
            const status = statusOf(def)
            return (
              <div key={def.role} data-testid={`role-${def.role}`} style={st.row}>
                <div style={st.head}>
                  <div style={s.itemName}>{def.label}</div>
                  <span style={status === 'set' ? st.badgeOk : st.badgeWarn}>
                    {status === 'set' ? 'Podešeno' : status === 'stale' ? '⚠ Naziv više ne postoji' : '⚠ Nije podešeno'}
                  </span>
                </div>
                <div style={st.desc}>{def.description}</div>
                <div style={st.pickers}>
                  {def.fields.map(f => {
                    const options = optionsFor(f, draft, structure, def)
                    const value = draft[f] || ''
                    // A saved name that no longer exists stays visible, marked.
                    const shown = value && !options.includes(value) ? [value, ...options] : options
                    return (
                      <label key={f} style={s.formField}>
                        <span style={s.formLabel}>{FIELD_LABEL[f]}</span>
                        <select style={s.formInput} value={value} disabled={!canEdit}
                          aria-label={`${def.label} — ${FIELD_LABEL[f]}`}
                          onChange={e => patch(def.role, f, e.target.value)}>
                          <option value="">— izaberite —</option>
                          {shown.map(o => (
                            <option key={o} value={o}>{options.includes(o) ? o : `${o} (ne postoji)`}</option>
                          ))}
                        </select>
                      </label>
                    )
                  })}
                  {canEdit && (
                    <button style={{ ...s.addBtn, alignSelf: 'flex-end' }} disabled={saving !== null}
                      onClick={() => save(def)}>
                      {saving === def.role ? 'Čuvanje…' : 'Sačuvaj'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

const st: Record<string, React.CSSProperties> = {
  row: { padding: '12px 16px', borderBottom: '0.5px solid rgba(255,255,255,0.05)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  desc: { fontSize: '12px', color: '#7A9BB8', margin: '4px 0 10px', lineHeight: 1.45 },
  pickers: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' },
  badgeOk: { fontSize: '11px', fontWeight: 500, padding: '2px 8px', borderRadius: '10px', background: 'rgba(0,212,126,0.12)', color: '#00D47E', whiteSpace: 'nowrap' },
  badgeWarn: { fontSize: '11px', fontWeight: 500, padding: '2px 8px', borderRadius: '10px', background: 'rgba(245,166,35,0.14)', color: '#F5A623', whiteSpace: 'nowrap' },
}
