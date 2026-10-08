import React, { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'
import { DIALOG } from './dialogTheme'
import { findExisting } from '../services/lookupNames'

// ── Adding a name that might already be there ───────────────────────────────
//
// This inserted whatever it was handed, without ever looking. That is how
// `Salary Expenses Domestic` came to sit beside `Salary expenses domestic`:
// one capital letter, months apart, and 2,172 accounting rows split across two
// lines neither of which was the cost of employing anybody.
//
// So it looks first, under the parent the name would go under, folding case
// and spacing exactly as the database's unique index does. A name that is
// already there is SELECTED rather than refused — the user wanted that
// account, it exists, and an error message would be telling them off for
// being right.

interface Props {
  // Which table to insert into
  table: 'pl_categories' | 'pl_subcategories' | 'departments' | 'dept_subcategories' | 'expense_descriptions'
  // Parent ID required for subcategories
  parentId?: string
  parentField?: string  // e.g. 'category_id', 'department_id', 'dept_subcategory_id'
  // Current count for sort_order
  currentCount: number
  // Called after successful insert with new item {id, name}
  onAdded: (item: { id: string; name: string }) => void
  // Placeholder text
  placeholder?: string
  // Disabled (e.g. subcategory when no parent selected)
  disabled?: boolean
}

export default function InlineCategoryAdd({
  table, parentId, parentField, currentCount,
  onAdded, placeholder, disabled = false
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (disabled) return
    setOpen(true)
    setValue('')
    setError('')
  }

  const handleCancel = () => {
    setOpen(false)
    setValue('')
    setError('')
  }

  const handleSave = async () => {
    const trimmed = value.trim()
    if (!trimmed) return
    setSaving(true)
    setError('')

    // ── Is it already there? ──────────────────────────────────────────────
    //
    // Narrowed to the parent, which is the whole of why this is a query and
    // not a scan of the table: eight departments each have their own `SaaS
    // expenses` and none is a duplicate of the others. Searching all of them
    // would refuse to create the ninth and file next month's spend under
    // somebody else's department.
    let lookup = supabase.from(table).select('id, name')
    if (parentId && parentField) lookup = lookup.eq(parentField, parentId)
    const { data: siblings, error: readErr } = await lookup

    // A failed read is NOT treated as "nothing is there". Inserting on the
    // back of a query that did not run is exactly the blind insert this
    // exists to stop, and it would be blind at the worst possible moment.
    if (readErr) {
      setError(readErr.message)
      setSaving(false)
      return
    }

    const already = findExisting((siblings || []) as { id: string; name: string }[], trimmed)
    if (already) {
      onAdded({ id: already.id, name: already.name })
      setOpen(false)
      setValue('')
      setSaving(false)
      return
    }

    // Build payload
    const payload: any = {
      name: trimmed,
      sort_order: currentCount + 1,
    }
    if (parentId && parentField) {
      payload[parentField] = parentId
    }

    const { data, error: err } = await supabase
      .from(table)
      .insert(payload)
      .select('id, name')
      .single()

    if (err) {
      // The database has the same rule and the last word on it. Two people
      // adding the same name at once get past the check above and meet the
      // unique index instead; the message it raises names an index, which
      // says nothing to whoever is typing.
      setError(/duplicate key|unique constraint/i.test(err.message)
        ? 'Somebody has just added that name. Close this and pick it from the list.'
        : err.message)
      setSaving(false)
      return
    }

    if (data) {
      onAdded({ id: data.id, name: data.name })
      setOpen(false)
      setValue('')
    }
    setSaving(false)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSave() }
    if (e.key === 'Escape') handleCancel()
  }

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? 'Select the parent category first' : 'Add a new category'}
        style={{
          background: 'none',
          border: `1px solid ${disabled ? 'rgba(255,255,255,0.10)' : DIALOG.accentSoft}`,
          borderRadius: '6px',
          color: disabled ? DIALOG.faint : DIALOG.accent,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '13px',
          fontWeight: '600',
          width: '32px',
          height: '32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'all 0.15s',
          padding: 0,
        }}
      >
        +
      </button>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      padding: '8px 10px',
      background: DIALOG.accentFill,
      border: `1.5px solid ${DIALOG.accentSoft}`,
      borderRadius: '8px',
      marginTop: '4px',
    }}>
      <div style={{ fontSize: '10px', fontWeight: '500', color: DIALOG.accent, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        New category
      </div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={value}
          onChange={e => { setValue(e.target.value); setError('') }}
          onKeyDown={handleKey}
          placeholder={placeholder || 'Enter a name…'}
          style={{
            flex: 1,
            fontFamily: 'system-ui,sans-serif',
            fontSize: '13px',
            padding: '6px 8px',
            border: `1px solid ${DIALOG.accentSoft}`,
            borderRadius: '6px',
            background: DIALOG.raised,
            color: DIALOG.text,
            outline: 'none',
          }}
        />
        <button
          onClick={handleSave}
          disabled={saving || !value.trim()}
          style={{
            fontFamily: 'system-ui,sans-serif',
            fontSize: '12px',
            padding: '6px 12px',
            border: 'none',
            borderRadius: '6px',
            background: DIALOG.accent,
            color: DIALOG.onAccent,
            cursor: saving || !value.trim() ? 'not-allowed' : 'pointer',
            opacity: saving || !value.trim() ? 0.6 : 1,
            whiteSpace: 'nowrap',
            fontWeight: '500',
          }}
        >
          {saving ? '...' : '✓ Add'}
        </button>
        <button
          onClick={handleCancel}
          style={{
            background: 'none',
            border: 'none',
            color: DIALOG.dim,
            cursor: 'pointer',
            fontSize: '16px',
            padding: '2px 4px',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {error && (
        <div style={{ fontSize: '11px', color: DIALOG.red }}>⚠️ {error}</div>
      )}
    </div>
  )
}