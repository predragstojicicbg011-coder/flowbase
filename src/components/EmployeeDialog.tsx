import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { showCompanyPicker } from '../services/companies'
import {
  fetchContracts, fetchDeductions, fetchAllocations, fetchAbsences,
  whyContractNotSavable, supersedeContract, serviceYearsFor, deductionWarning,
  editingContractLeaves,
  ABSENCE_REASONS, absenceLabel,
  type EmployeeRow, type ContractRow, type DeductionRow,
  type CostAllocationRow, type AbsenceRow,
} from '../services/payroll/employees'
import { splitContractedNet } from '../services/payroll/engine'
import SearchableSelect from './SearchableSelect'
import { fetchAllPartners } from '../services/allPartners'
import { fmtLocal, fmtNum } from '../utils/formatters'
import { OVERHEAD_LABEL } from '../services/projects'
import {
  PL_CATEGORY, SUBCATEGORY, SALARY_DEPT_SUBCATEGORY, OTHER_INCOME_SUBCATEGORY,
} from '../services/payroll/booking'

/**
 * One employee: who they are, the contracts they have had, and what is
 * deducted.
 *
 * A CONTRACT IS NEVER EDITED INTO A NEW ONE. A pay rise ends the old contract
 * on the day the new one starts and inserts a successor, the same way a
 * payroll setting changes — because editing in place would rewrite what the
 * earlier months cost, and those months have already been checked against the
 * accountant. The history stays visible for that reason too: it is the record
 * of what each past month was calculated from.
 */
export default function EmployeeDialog({ employee, companies, seniorityCoefficient, onClose, onSaved }: {
  employee: EmployeeRow | null
  companies: { id: string; name: string }[]
  /**
   * From the payroll settings, for the base/seniority preview only.
   *
   * `null` when the settings have no figure for today, and the preview then
   * says so rather than showing a split worked out from a guessed coefficient
   * — which would read as a checked figure.
   */
  seniorityCoefficient: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !employee
  const [tab, setTab] = useState<TabKey>('person')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [person, setPerson] = useState({
    company_id: employee?.company_id || companies[0]?.id || '',
    code: employee?.code || '',
    full_name: employee?.full_name || '',
    organisational_unit: employee?.organisational_unit || '',
    hired_on: employee?.hired_on || '',
    seniority_from: employee?.seniority_from || '',
    left_on: employee?.left_on || '',
    note: employee?.note || '',
  })

  const [contracts, setContracts] = useState<ContractRow[]>([])
  /**
   * The partner book, for the payee picker on a deduction.
   *
   * Paged: it is past a thousand, and an unpaged read of it hands back an
   * arbitrary thousand — which is how an employee who was plainly in the book
   * came to be reported as missing from it.
   */
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([])
  const [deductions, setDeductions] = useState<DeductionRow[]>([])
  const [allocations, setAllocations] = useState<CostAllocationRow[]>([])
  const [absences, setAbsences] = useState<AbsenceRow[]>([])

  // The one in force today. There is at most one, by constraint.
  const today = new Date().toISOString().slice(0, 10)
  const currentAllocation = allocations.find(a =>
    a.valid_from <= today && (a.valid_to === null || today < a.valid_to)) || null
  const currentAbsence = absences.find(a =>
    a.valid_from <= today && (a.valid_to === null || today < a.valid_to)) || null

  useEffect(() => {
    if (!employee) return
    fetchContracts(supabase, [employee.id]).then(setContracts).catch(e => setError(e.message))
    fetchDeductions(supabase, [employee.id]).then(setDeductions).catch(e => setError(e.message))
    fetchAllocations(supabase, [employee.id]).then(setAllocations).catch(e => setError(e.message))
    fetchAbsences(supabase, [employee.id]).then(setAbsences).catch(e => setError(e.message))
    fetchAllPartners<{ id: string; name: string }>(supabase, 'id,name')
      .then(setPartners).catch(e => setError(e.message))
  }, [employee])

  /**
   * Remove an employee, with everything dated that hangs off them.
   *
   * IT REFUSES ONCE A MONTH HAS BEEN CALCULATED FROM THEM. A timesheet or a
   * posting means somebody has been paid, or at least that a figure has been
   * checked against the accountant, and every table here cascades — deleting
   * would take the record of that with it and leave a total nothing explains.
   * Those are corrected by ending the contract or marking them as having left,
   * both of which keep the history.
   *
   * What it is FOR is the case this was written after: a duplicate created by
   * accident, because the list could not show the person who already existed.
   * That one has nothing attached and should be simple to undo.
   */
  const removePerson = async () => {
    if (!employee) return
    setDeleting(true); setError(null)

    const counts = await Promise.all([
      supabase.from('payroll_timesheets').select('id', { count: 'exact', head: true })
        .eq('employee_id', employee.id),
      supabase.from('employee_contracts').select('id', { count: 'exact', head: true })
        .eq('employee_id', employee.id),
      supabase.from('employee_deductions').select('id', { count: 'exact', head: true })
        .eq('employee_id', employee.id),
      supabase.from('employee_cost_allocation').select('id', { count: 'exact', head: true })
        .eq('employee_id', employee.id),
    ])
    const [timesheets, contracts_, deductions_, allocations_] =
      counts.map(c => c.count || 0)

    if (timesheets > 0) {
      setDeleting(false)
      setError(
        `${employee.full_name} has ${timesheets} month${timesheets === 1 ? '' : 's'} of hours `
        + 'recorded, which means a payroll has been calculated from them. Deleting would '
        + 'take that with it and leave a total nothing explains. Mark them as having left '
        + 'instead — that keeps every month they were here.')
      return
    }

    const attached = [
      contracts_ && `${contracts_} contract${contracts_ === 1 ? '' : 's'}`,
      deductions_ && `${deductions_} deduction${deductions_ === 1 ? '' : 's'}`,
      allocations_ && `${allocations_} cost allocation${allocations_ === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', ')

    if (!window.confirm(
      `Delete ${employee.full_name}?`
      + (attached ? `\n\nThis also removes: ${attached}.` : '\n\nNothing else is attached.')
      + '\n\nThis cannot be undone.')) {
      setDeleting(false)
      return
    }

    const { data, error: err } = await supabase
      .from('employees').delete().eq('id', employee.id).select('id')
    setDeleting(false)
    if (err) { setError(`They could not be deleted: ${err.message}`); return }
    if (!data || data.length === 0) {
      setError('Nothing was deleted and the database reported no error, which usually '
        + 'means the write was refused.')
      return
    }
    onSaved()
  }

  const savePerson = async () => {
    if (!person.full_name.trim()) { setError('Enter the employee name.'); return }
    if (!person.company_id) { setError('Choose which company employs them.'); return }
    setSaving(true); setError(null)
    const row = {
      ...person,
      code: person.code.trim() || null,
      // Kept exactly as the register spells it, because a re-import matches on
      // it. It is no longer edited here: what a cost is filed under is the
      // department on the allocation, and two fields meaning the same thing is
      // how they come to disagree.
      organisational_unit: person.organisational_unit.trim() || null,
      hired_on: person.hired_on || null,
      seniority_from: person.seniority_from || null,
      left_on: person.left_on || null,
      note: person.note.trim() || null,
    }
    const { data, error: err } = employee
      ? await supabase.from('employees').update(row).eq('id', employee.id).select('id')
      : await supabase.from('employees').insert(row).select('id')
    setSaving(false)

    if (err) {
      // A code already in use is the one failure that happens by accident,
      // and "duplicate key value violates unique constraint" tells somebody
      // adding a colleague nothing at all.
      setError(/duplicate key|unique constraint/i.test(err.message)
        ? `Somebody at this company already has the code "${person.code.trim()}". `
          + 'Codes come from MPP and each belongs to one person, so this is either a '
          + 'typo or they are already here — search the list for them before adding '
          + 'a second record.'
        : `The employee could not be saved: ${err.message}`)
      return
    }

    // A refused write comes back as a success with no rows, which used to
    // close the dialog over an employee that was never created.
    if (!data || data.length === 0) {
      setError('Nothing was saved and the database reported no error, which usually '
        + 'means the write was refused. Check you are signed in as an administrator '
        + 'or owner.')
      return
    }

    onSaved()
  }

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.dialog} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div>
            <div style={s.title}>{isNew ? 'New employee' : person.full_name}</div>
            <div style={s.sub}>
              {isNew
                ? 'The contract and any deductions are added once they are saved'
                : 'Contracts are dated — a pay rise ends the old one; ✎ corrects one that was typed wrongly'}
            </div>
          </div>
          <button style={s.close} onClick={onClose}>✕</button>
        </div>

        <div style={s.tabs}>
          {TABS.map(([key, label]) => (
            <button key={key}
              style={{ ...s.tab, ...(tab === key ? s.tabOn : {}) }}
              disabled={key !== 'person' && isNew}
              title={key !== 'person' && isNew ? 'Save the employee first' : undefined}
              onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {error && <div style={s.error}>{error}</div>}

        {currentAbsence && (
          <div style={s.offBanner}>
            <b>Off payroll since {currentAbsence.valid_from}</b>
            {currentAbsence.valid_to && ` until ${currentAbsence.valid_to}`}
            {' — '}{absenceLabel(currentAbsence.reason).toLowerCase()}. Nothing below is
            calculated or paid for those months; it is all kept for when they return.
          </div>
        )}

        <div style={s.body}>
          {tab === 'person' && (
            <div style={s.grid}>
              <Field label="Full name">
                <input style={s.input} value={person.full_name}
                  onChange={e => setPerson({ ...person, full_name: e.target.value })} />
              </Field>
              {showCompanyPicker(companies) && (
                <Field label="Company">
                  <select style={s.input} value={person.company_id}
                    onChange={e => setPerson({ ...person, company_id: e.target.value })}>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Code in MPP" hint="How a row here is matched to a row in an export">
                <input style={s.input} value={person.code}
                  onChange={e => setPerson({ ...person, code: e.target.value })} />
              </Field>
              <Field label="Department"
                hint="Set on the Cost allocation tab, with the dates it applies — it is
                  what every entry this person generates posts to.">
                <div style={s.readOnly}>
                  {currentAllocation
                    ? <>
                        {currentAllocation.department}
                        {currentAllocation.dept_subcategory && ` · ${currentAllocation.dept_subcategory}`}
                      </>
                    : <span style={{ color: '#C8A24A' }}>
                        Not allocated — nothing can be posted for them yet
                      </span>}
                </div>
              </Field>
              <Field label="Hired on">
                <input type="date" style={s.input} value={person.hired_on}
                  onChange={e => setPerson({ ...person, hired_on: e.target.value })} />
              </Field>
              <Field label="Seniority counts from"
                hint="Датум почетка последњег ангажовања. Without it nobody gets any seniority.">
                <input type="date" style={s.input} value={person.seniority_from}
                  onChange={e => setPerson({ ...person, seniority_from: e.target.value })} />
              </Field>
              <Field label="Left on" hint="The last day worked — that month is still paid">
                <input type="date" style={s.input} value={person.left_on}
                  onChange={e => setPerson({ ...person, left_on: e.target.value })} />
              </Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <Field label="Note">
                  <textarea style={{ ...s.input, minHeight: '56px', resize: 'vertical' as const }}
                    value={person.note} onChange={e => setPerson({ ...person, note: e.target.value })} />
                </Field>
              </div>
            </div>
          )}

          {tab === 'contracts' && employee && (
            <ContractsTab employee={employee} contracts={contracts}
              seniorityCoefficient={seniorityCoefficient}
              onChanged={() => fetchContracts(supabase, [employee.id]).then(setContracts)} />
          )}

          {tab === 'allocation' && employee && (
            <AllocationTab employee={employee} rows={allocations}
              onChanged={() => fetchAllocations(supabase, [employee.id]).then(setAllocations)} />
          )}

          {tab === 'absence' && employee && (
            <AbsenceTab employee={employee} rows={absences}
              onChanged={() => fetchAbsences(supabase, [employee.id]).then(setAbsences)} />
          )}

          {tab === 'deductions' && employee && (
            <DeductionsTab employee={employee} deductions={deductions} partners={partners}
              payerName={companies.find(c => c.id === person.company_id)?.name || null}
              onChanged={() => fetchDeductions(supabase, [employee.id]).then(setDeductions)} />
          )}
        </div>

        {tab === 'person' && (
          <div style={s.footer}>
            {!isNew && (
              <button style={s.danger} disabled={deleting} onClick={removePerson}>
                {deleting ? 'Checking…' : 'Delete'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button style={s.ghost} onClick={onClose}>Cancel</button>
            <button style={s.primary} onClick={savePerson} disabled={saving}>
              {saving ? 'Saving…' : isNew ? 'Create employee' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Contracts ──────────────────────────────────────────────────────────────

export function ContractsTab({ employee, contracts, seniorityCoefficient, onChanged }: {
  employee: EmployeeRow
  contracts: ContractRow[]
  seniorityCoefficient: number | null
  onChanged: () => void
}) {
  const [draft, setDraft] = useState({
    valid_from: '', currency: 'RSD', net_amount: '', service_years: '', note: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * The contract being corrected, if any.
   *
   * A CORRECTION IS NOT A PAY RISE, and the distinction is the whole reason
   * both exist. A rise is a new contract that ends the old one, so August
   * stays what August was. A figure typed wrongly is not a rise: adding a
   * second contract from today leaves August wrong for ever, and adding one
   * dated August collides with the row it was meant to replace. There was no
   * third option, so a mistyped salary could not be put right at all.
   */
  const [editing, setEditing] = useState<ContractRow | null>(null)
  const [edit, setEdit] = useState({
    valid_from: '', valid_to: '', currency: 'RSD', net_amount: '',
    service_years: '', note: '',
  })

  const open = useMemo(() => contracts.find(c => c.valid_to === null) || null, [contracts])
  const today = new Date().toISOString().slice(0, 10)

  const startEditing = (c: ContractRow) => {
    setError(null)
    setEditing(c)
    setEdit({
      valid_from: c.valid_from,
      valid_to: c.valid_to || '',
      currency: c.currency,
      net_amount: String(c.net_amount),
      service_years: c.service_years == null ? '' : String(c.service_years),
      note: c.note || '',
    })
  }

  /**
   * What this edit would leave behind — shown while it is being typed, not
   * after it is saved.
   *
   * Warnings, never refusals. Every one of them is something somebody may
   * genuinely mean: ending a contract because the person left, moving a start
   * date because the first was mistyped. What they must not be is invisible.
   */
  const consequences = useMemo(() => {
    if (!editing || !edit.valid_from) return []
    return editingContractLeaves(
      contracts,
      { id: editing.id, valid_from: edit.valid_from, valid_to: edit.valid_to || null },
      today)
  }, [editing, edit.valid_from, edit.valid_to, contracts, today])

  const saveEdit = async () => {
    if (!editing) return
    const why = whyContractNotSavable(
      {
        id: editing.id,
        valid_from: edit.valid_from,
        valid_to: edit.valid_to || null,
        net_amount: edit.net_amount,
      },
      contracts)
    if (why) { setError(why); return }

    setBusy(true); setError(null)
    const { error: err } = await supabase.from('employee_contracts').update({
      valid_from: edit.valid_from,
      valid_to: edit.valid_to || null,
      currency: edit.currency,
      net_amount: Number(edit.net_amount),
      service_years: edit.service_years.trim() === '' ? null : Number(edit.service_years),
      note: edit.note.trim() || null,
    }).eq('id', editing.id).select('id')
    setBusy(false)
    if (err) {
      setError(err.message.includes('no_overlap')
        ? 'Another contract already covers that period, so this one cannot move there.'
        : `The contract could not be changed: ${err.message}`)
      return
    }
    setEditing(null)
    onChanged()
  }

  const add = async () => {
    const why = whyContractNotSavable(
      { valid_from: draft.valid_from, valid_to: null, net_amount: draft.net_amount },
      // The open contract will be closed on the same day, so it is not a clash.
      contracts.filter(c => c.id !== open?.id))
    if (why) { setError(why); return }
    if (open && draft.valid_from <= open.valid_from) {
      setError(`The current contract starts on ${open.valid_from}. A new one has to start after that.`)
      return
    }
    setBusy(true); setError(null)

    // The new contract goes in FIRST. The other order ends the current one and
    // can then fail, leaving the employee with no contract at all — and a
    // person with no contract drops out of every payroll run.
    const { error: insErr } = await supabase.from('employee_contracts').insert({
      employee_id: employee.id,
      valid_from: draft.valid_from,
      valid_to: null,
      currency: draft.currency,
      net_amount: Number(draft.net_amount),
      // Empty means derive it, which is what it should be almost always.
      service_years: draft.service_years.trim() === '' ? null : Number(draft.service_years),
      note: draft.note.trim() || null,
    }).select('id')

    if (insErr) {
      setBusy(false)
      setError(insErr.message.includes('no_overlap')
        ? 'Another contract already covers that period. End it first.'
        : `The contract could not be added: ${insErr.message}`)
      return
    }

    if (open) {
      const { id, valid_to } = supersedeContract(open, draft.valid_from)
      const { error: endErr } = await supabase.from('employee_contracts')
        .update({ valid_to }).eq('id', id).select('id')
      if (endErr) {
        setBusy(false)
        setError('The new contract was added, but the previous one could not be ended '
          + `(${endErr.message}). Both now claim the same months — end the one starting `
          + `${open.valid_from} before running a payroll.`)
        onChanged()
        return
      }
    }

    setBusy(false)
    setDraft({ valid_from: '', currency: 'RSD', net_amount: '', service_years: '', note: '' })
    onChanged()
  }

  const remove = async (c: ContractRow) => {
    if (!window.confirm(
      `Delete the contract from ${c.valid_from}? Any month calculated from it will `
      + 'no longer reproduce.')) return
    const { error: err } = await supabase.from('employee_contracts').delete().eq('id', c.id).select('id')
    if (err) { setError(`It could not be deleted: ${err.message}`); return }
    onChanged()
  }

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.sectionLabel}>History</div>
      {contracts.length === 0 && <div style={s.empty}>No contract yet. Add the first one below.</div>}
      {contracts.map(c => {
        // Seniority as at the last month this contract applies to: today while
        // it is still running, its final month once it has been superseded.
        // Shown for one date because it goes up every anniversary, and a card
        // cannot show a figure that changes without saying when it is true.
        const asAt = c.valid_to === null ? today : c.valid_to
        const { years, derived } = serviceYearsFor(employee, c, asAt)
        const split = seniorityCoefficient === null
          ? null
          : splitContractedNet(c.net_amount, years, seniorityCoefficient)
        return (
          <div key={c.id} style={{ ...s.card, ...(c.valid_to === null ? s.cardOpen : {}) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={s.cardTitle}>
                {c.valid_from} → {c.valid_to || 'still in force'}
              </div>
              {/* NAMED AND VISIBLE, both of them.
                  These were two emoji at 35% opacity with no colour of their
                  own — invisible on this card, as the owner found by not
                  finding them. A control that has to be hunted for is a
                  control that does not exist, and the delete button had been
                  in that state since it was written. */}
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button className="mf-card-action" style={s.cardAction}
                  title="Correct this contract — for a figure typed wrongly, not for a pay rise"
                  onClick={() => startEditing(c)}>✎ Correct</button>
                <button className="mf-card-danger" style={s.cardAction}
                  title="Delete this contract entirely"
                  onClick={() => remove(c)}>Delete</button>
              </div>
            </div>
            <div style={s.cardRow}>
              <b style={{ color: '#DCE9F6' }}>
                {fmtLocal(c.net_amount, c.currency)}
              </b>
              <span> net, including seniority</span>
            </div>
            <div style={s.cardMeta}>
              {years} {years === 1 ? 'year' : 'years'} of service
              {derived
                ? <span title={`Counted from ${employee.seniority_from || 'no date set'}, as at ${asAt}`}>
                    {' (as at '}{asAt}{')'}
                  </span>
                : <span style={{ color: '#C8A24A' }}>{' (entered by hand)'}</span>}
              {split
                ? <>
                    {' · base '}
                    {fmtNum(split.base)}
                    {' + seniority '}
                    {fmtNum(split.seniority)}
                  </>
                : <span style={{ color: '#C8A24A' }}>
                    {' · the seniority coefficient is not set, so the split is not shown'}
                  </span>}
            </div>
            {c.note && <div style={s.cardNote}>{c.note}</div>}
          </div>
        )
      })}

      {editing ? (
        <>
          <div style={s.sectionLabel}>
            Correcting the contract from {editing.valid_from}
          </div>

          {/* Said while it is being typed, not after it is saved. */}
          {consequences.length > 0 && (
            <div style={{
              border: '1px solid rgba(245,166,35,0.35)', background: 'rgba(245,166,35,0.08)',
              borderRadius: '8px', padding: '10px 13px', marginBottom: '12px',
              fontSize: '12px', color: '#F5A623', lineHeight: 1.6,
            }}>
              {consequences.map((c, i) => <div key={i}>{c}</div>)}
            </div>
          )}

          <div style={s.grid}>
            <Field label="In force from">
              <input type="date" style={s.input} value={edit.valid_from}
                onChange={e => setEdit({ ...edit, valid_from: e.target.value })} />
            </Field>
            <Field label="In force until"
              hint="Empty means still in force. This is normally set by the next contract starting.">
              <input type="date" style={s.input} value={edit.valid_to}
                onChange={e => setEdit({ ...edit, valid_to: e.target.value })} />
            </Field>
            <Field label="Currency">
              <select style={s.input} value={edit.currency}
                onChange={e => setEdit({ ...edit, currency: e.target.value })}>
                <option value="RSD">RSD</option>
                <option value="EUR">EUR</option>
                {/* A payroll converts contract terms at the EUR rate only; USD stays for a term written before. */}

                {edit.currency === 'USD' && <option value="USD">USD</option>}
              </select>
            </Field>
            <Field label="Contracted net" hint="The total on the payslip, seniority included">
              <input style={s.input} inputMode="decimal" value={edit.net_amount}
                onChange={e => setEdit({ ...edit, net_amount: e.target.value })} />
            </Field>
            <Field label="Years of service"
              hint="Leave empty — it is counted from the seniority date. Fill it in only where MPP disagrees.">
              <input style={s.input} inputMode="numeric" placeholder="derived"
                value={edit.service_years}
                onChange={e => setEdit({ ...edit, service_years: e.target.value })} />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Note">
                <input style={s.input} value={edit.note}
                  onChange={e => setEdit({ ...edit, note: e.target.value })} />
              </Field>
            </div>
          </div>
          <div style={{ marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button style={s.primary} onClick={saveEdit} disabled={busy}>
              {busy ? 'Saving…' : 'Save the correction'}
            </button>
            <button style={s.ghost} onClick={() => { setEditing(null); setError(null) }}>
              Cancel
            </button>
            <span style={{ fontSize: '11.5px', color: '#7A9BB8' }}>
              For a pay rise, cancel and add a new contract instead — that keeps what
              the old months cost.
            </span>
          </div>
        </>
      ) : (
      <>
      <div style={s.sectionLabel}>
        {open ? 'New contract — the current one ends the day this begins' : 'Add a contract'}
      </div>
      <div style={s.grid}>
        <Field label="In force from">
          <input type="date" style={s.input} value={draft.valid_from}
            onChange={e => setDraft({ ...draft, valid_from: e.target.value })} />
        </Field>
        <Field label="Currency">
          <select style={s.input} value={draft.currency}
            onChange={e => setDraft({ ...draft, currency: e.target.value })}>
            <option value="RSD">RSD</option>
            <option value="EUR">EUR</option>
            {/* A payroll converts contract terms at the EUR rate only; USD stays for a term written before. */}

            {draft.currency === 'USD' && <option value="USD">USD</option>}
          </select>
        </Field>
        <Field label="Contracted net" hint="The total on the payslip, seniority included">
          <input style={s.input} inputMode="decimal" value={draft.net_amount}
            onChange={e => setDraft({ ...draft, net_amount: e.target.value })} />
        </Field>
        <Field label="Years of service"
          hint="Leave empty — it is counted from the seniority date. Fill it in only where MPP disagrees.">
          <input style={s.input} inputMode="numeric" placeholder="derived"
            value={draft.service_years}
            onChange={e => setDraft({ ...draft, service_years: e.target.value })} />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Note">
            <input style={s.input} value={draft.note}
              onChange={e => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
      </div>
      <div style={{ marginTop: '12px' }}>
        <button style={s.primary} onClick={add} disabled={busy}>
          {busy ? 'Saving…' : 'Add contract'}
        </button>
      </div>
      </>
      )}
    </div>
  )
}

// ─── Deductions ─────────────────────────────────────────────────────────────

function DeductionsTab({ employee, deductions, partners, payerName, onChanged }: {
  partners: { id: string; name: string }[]
  employee: EmployeeRow
  deductions: DeductionRow[]
  /**
   * The company that pays this person, so a deduction can say when it claims
   * to forward money to a third party and then names the payer as the one
   * receiving it. See deductionWarning().
   */
  payerName: string | null
  onChanged: () => void
}) {
  const blank = {
    id: '', label: '', goes_to: 'employer' as 'third_party' | 'employer',
    payee: '', payee_partner_id: '',
    kind: 'amount' as 'amount' | 'percent', currency: 'RSD', value: '',
    valid_from: '', valid_to: '', is_active: true, note: '',
  }
  const [draft, setDraft] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = draft.id !== ''

  const edit = (d: DeductionRow) => {
    setError(null)
    setDraft({
      id: d.id,
      label: d.label,
      goes_to: d.goes_to,
      payee: d.payee || '',
      payee_partner_id: d.payee_partner_id || '',
      kind: d.amount !== null ? 'amount' : 'percent',
      currency: d.currency || 'RSD',
      value: d.amount !== null ? String(d.amount) : String((d.percent_of_net || 0) * 100),
      valid_from: d.valid_from,
      valid_to: d.valid_to || '',
      is_active: d.is_active !== false,
      note: d.note || '',
    })
  }

  const save = async () => {
    if (!draft.label.trim()) { setError('Give the deduction a name.'); return }
    if (!draft.valid_from) { setError('Say which date it starts.'); return }
    if (draft.valid_to && draft.valid_to <= draft.valid_from) {
      setError('The end date has to be after the start date.'); return
    }
    const value = Number(draft.value)
    if (!Number.isFinite(value) || value <= 0) { setError('Enter how much is deducted.'); return }
    if (draft.kind === 'percent' && value > 100) { setError('A percentage cannot be over 100.'); return }

    setBusy(true); setError(null)
    const row = {
      employee_id: employee.id,
      label: draft.label.trim(),
      goes_to: draft.goes_to,
      payee: draft.payee.trim() || null,
      // Both. The id is what the posting goes on; the name is what the
      // arrangement says and what a reader of the row expects to see, and it
      // is what the row falls back to if the partner is ever deleted.
      payee_partner_id: draft.payee_partner_id || null,
      // A percentage has no currency to be in, and the database refuses one.
      currency: draft.kind === 'amount' ? draft.currency : 'RSD',
      amount: draft.kind === 'amount' ? value : null,
      percent_of_net: draft.kind === 'percent' ? value / 100 : null,
      valid_from: draft.valid_from,
      valid_to: draft.valid_to || null,
      is_active: draft.is_active,
      note: draft.note.trim() || null,
    }
    const { data, error: err } = editing
      ? await supabase.from('employee_deductions').update(row).eq('id', draft.id).select('id')
      : await supabase.from('employee_deductions').insert(row).select('id')
    setBusy(false)
    if (err) { setError(`The deduction could not be saved: ${err.message}`); return }
    if (!data || data.length === 0) {
      setError('Nothing was saved and the database reported no error, which usually '
        + 'means the write was refused. Check you are signed in as an administrator.')
      return
    }
    setDraft(blank)
    onChanged()
  }

  /**
   * Switching one off, which is how a suspension is actually recorded.
   *
   * Not an end date: it is the same arrangement when it resumes, and ending it
   * would leave somebody to re-create it and lose that. Not a delete either,
   * which would lose the months it did run.
   */
  const toggle = async (d: DeductionRow) => {
    const { data, error: err } = await supabase.from('employee_deductions')
      .update({ is_active: d.is_active === false }).eq('id', d.id).select('id')
    if (err) { setError(`It could not be switched: ${err.message}`); return }
    if (!data || data.length === 0) { setError('The change was refused.'); return }
    onChanged()
  }

  const end = async (d: DeductionRow) => {
    const date = window.prompt(
      `End "${d.label}" from which date? To pause it instead use Off, which keeps it `
      + 'as the same arrangement.', new Date().toISOString().slice(0, 10))
    if (!date) return
    const { error: err } = await supabase.from('employee_deductions')
      .update({ valid_to: date }).eq('id', d.id).select('id')
    if (err) { setError(`It could not be ended: ${err.message}`); return }
    onChanged()
  }

  const remove = async (d: DeductionRow) => {
    if (!window.confirm(
      `Delete "${d.label}" entirely? The months it already ran in would no longer `
      + 'recalculate. Switching it off or ending it keeps that history.')) return
    const { error: err } = await supabase.from('employee_deductions').delete().eq('id', d.id).select('id')
    if (err) { setError(`It could not be deleted: ${err.message}`); return }
    if (draft.id === d.id) setDraft(blank)
    onChanged()
  }

  const money = (d: DeductionRow) => d.amount !== null
    ? fmtLocal(d.amount, d.currency || 'RSD')
    : `${((d.percent_of_net || 0) * 100).toFixed(2)}% of net`

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.hintBox}>
        A deduction paid on to a third party — a loan, a union, a garnishment — leaves the
        company and is a payable. One that stays with the employer, such as a membership the
        company buys and then withholds, does not. It changes nobody pay either way, so it
        will never show up as a discrepancy against the accountant; it only decides how the
        amount is booked. The imported ones are all marked <b>stays with the employer</b>,
        which is a reading of the register rather than something it stated.
      </div>

      {deductions.length === 0 && <div style={s.empty}>Nothing is deducted from this employee.</div>}
      {deductions.map(d => {
        const off = d.is_active === false
        return (
          <div key={d.id} style={{
            ...s.card,
            ...(d.valid_to === null && !off ? s.cardOpen : {}),
            ...(off ? s.cardOff : {}),
            ...(draft.id === d.id ? s.cardEditing : {}),
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={s.cardTitle}>
                {d.label}
                {off && <span style={s.offBadge}>Off</span>}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button style={s.ghostSmall} onClick={() => edit(d)}>Edit</button>
                <button style={s.ghostSmall} onClick={() => toggle(d)}>{off ? 'On' : 'Off'}</button>
                {d.valid_to === null && <button style={s.ghostSmall} onClick={() => end(d)}>End</button>}
                <button className="mf-trash" title="Delete" aria-label="Delete" style={s.deleteBtn} onClick={() => remove(d)}>&#128465;</button>
              </div>
            </div>
            <div style={s.cardRow}>
              <b style={{ color: off ? '#5C7894' : '#DCE9F6' }}>{money(d)}</b>
              <span style={{
                ...s.badge,
                background: d.goes_to === 'third_party' ? 'rgba(255,91,90,0.13)' : 'rgba(255,255,255,0.06)',
                color: d.goes_to === 'third_party' ? '#FF5B5A' : '#7A9BB8',
              }}>
                {/* The payee is shown either way. On an employer-held
                    deduction it is the EVIDENCE for that classification: the
                    twenty imported from the MPP register all name
                    the employer, which is what makes them a benefit the
                    company buys and then withholds rather than money
                    forwarded on. Hidden, the classification read as a guess
                    and got flagged as one for three days. */}
                {d.goes_to === 'third_party' ? 'To third party' : 'Stays with employer'}
                {d.payee ? ` \u00b7 ${d.payee}` : ''}
              </span>
            </div>
            {/* A row can be filled in so that it quietly does the wrong thing
                \u2014 deducts nothing, or books a payable owed to nobody \u2014 and
                none of those is a refusal. See deductionWarning(). */}
            {deductionWarning(d, payerName) && (
              <div style={s.cardWarn}>{deductionWarning(d, payerName)}</div>
            )}
            <div style={s.cardMeta}>
              {d.valid_from} &rarr; {d.valid_to || (off ? 'paused' : 'still running')}
              {(d.currency || 'RSD') !== 'RSD' && ' \u00b7 converted at the rate of the month'}
            </div>
            {d.note && <div style={s.cardNote}>{d.note}</div>}
          </div>
        )
      })}

      <div style={s.sectionLabel}>
        {editing ? `Editing ${draft.label || 'a deduction'}` : 'Add a deduction'}
      </div>
      <div style={s.grid}>
        <Field label="Name">
          <input style={s.input} value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })} />
        </Field>
        <Field label="Where it goes">
          <select style={s.input} value={draft.goes_to}
            onChange={e => setDraft({ ...draft, goes_to: e.target.value as any })}>
            <option value="employer">Stays with the employer</option>
            <option value="third_party">To a third party</option>
          </select>
        </Field>
        {/* PICKED, not typed.
            The payee used to be free text, and a payroll forwarding the
            deduction then had to guess which partner `Generali Osiguranje`
            meant — a rule forgiving enough to reach `Generali Osiguranje
            a.d.o.` also reaches `Generali Investments`, which is reported
            rather than guessed and is still a deduction posted with no
            partner. Chosen from the book, there is nothing to guess.

            The text field stays underneath for a payee that genuinely is not
            a partner — a court, a person — because refusing to record one
            would be a worse answer than an unmatched name. */}
        <Field label="Payee" hint="Pick the partner it is forwarded to, so the posting can find them">
          <SearchableSelect
            value={draft.payee_partner_id}
            onChange={id => {
              const chosen = partners.find(p => p.id === id)
              setDraft({
                ...draft,
                payee_partner_id: id,
                // The name follows the choice, so the row reads correctly and
                // still matches if the partner is deleted later.
                payee: chosen ? chosen.name : draft.payee,
              })
            }}
            options={partners.map(p => ({ value: p.id, label: p.name }))}
            allLabel="— not a partner —"
            searchPlaceholder="Type to find a partner…"
            emptyMessage="No partner of that name"
            style={s.input}
          />
        </Field>
        <Field label="Payee as the arrangement names it"
          hint={draft.payee_partner_id
            ? 'Taken from the partner you picked. Edit it only if the paperwork says otherwise.'
            : 'Free text, for a payee that is not in Partners. The posting will try to match it.'}>
          <input style={s.input} value={draft.payee}
            onChange={e => setDraft({ ...draft, payee: e.target.value })} />
        </Field>
        <Field label="How it is worked out">
          <select style={s.input} value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value as any })}>
            <option value="amount">A fixed amount</option>
            <option value="percent">A percentage of net</option>
          </select>
        </Field>
        <Field label={draft.kind === 'amount' ? 'Amount' : 'Percent of net'}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input style={s.input} inputMode="decimal" value={draft.value}
              onChange={e => setDraft({ ...draft, value: e.target.value })} />
            {draft.kind === 'amount' && (
              <select style={{ ...s.input, width: '88px' }} value={draft.currency}
                onChange={e => setDraft({ ...draft, currency: e.target.value })}>
                <option value="RSD">RSD</option>
                <option value="EUR">EUR</option>
                {/* A payroll converts contract terms at the EUR rate only; USD stays for a term written before. */}

                {draft.currency === 'USD' && <option value="USD">USD</option>}
              </select>
            )}
          </div>
        </Field>
        <Field label="Running">
          <label style={s.checkLine}>
            <input type="checkbox" checked={draft.is_active}
              onChange={e => setDraft({ ...draft, is_active: e.target.checked })} />
            <span>{draft.is_active ? 'Deducted each month' : 'Paused, and skipped by every run'}</span>
          </label>
        </Field>
        <Field label="From">
          <input type="date" style={s.input} value={draft.valid_from}
            onChange={e => setDraft({ ...draft, valid_from: e.target.value })} />
        </Field>
        <Field label="Until" hint="Leave empty while it is still running">
          <input type="date" style={s.input} value={draft.valid_to}
            onChange={e => setDraft({ ...draft, valid_to: e.target.value })} />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Note">
            <input style={s.input} value={draft.note}
              onChange={e => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
        <button style={s.primary} onClick={save} disabled={busy}>
          {busy ? 'Saving...' : editing ? 'Save changes' : 'Add deduction'}
        </button>
        {editing && (
          <button style={s.ghost} onClick={() => { setDraft(blank); setError(null) }}>
            Cancel, and add a new one instead
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Which department this person's cost lands in, with dates. Which PROJECT it
 * goes to is not set here: payroll cost follows the hours on each project,
 * entered on the timesheet ("Sati po projektima").
 *
 * Dated for the same reason everything else here is: somebody who moved from
 * Marketing to Dev in June did not retroactively cost Dev anything in May, and
 * a posting for May has to keep saying Marketing or the department report
 * quietly rewrites its own history.
 *
 * It starts out filled in from the organisational unit, so the ordinary case
 * needs nothing done to it — but it is a separate record, because where a
 * person's cost belongs is a decision and their unit is just a label.
 */
function AllocationTab({ employee, rows, onChanged }: {
  employee: EmployeeRow
  rows: CostAllocationRow[]
  onChanged: () => void
}) {
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([])
  const [subcategories, setSubcategories] = useState<{ id: string; name: string; department_id: string }[]>([])

  useEffect(() => {
    // Straight from the ledger's own lists rather than typed. A department
    // spelled slightly differently here would create a second heading beside
    // the real one, and the P&L would show both with part of the payroll in
    // each.
    Promise.all([
      supabase.from('departments').select('id,name,sort_order').order('sort_order'),
      supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
    ]).then(([d, sc]) => {
      setDepartments(d.data || [])
      setSubcategories(sc.data || [])
    })
  }, [])
  const blank = {
    id: '', department: '', dept_subcategory: '',
    valid_from: '', valid_to: '', note: '',
  }
  const [draft, setDraft] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!draft.department.trim()) { setError('Say which department carries this cost.'); return }
    if (!draft.valid_from) { setError('Say which date it takes effect from.'); return }
    if (draft.valid_to && draft.valid_to <= draft.valid_from) {
      setError('The end date has to be after the start date.'); return
    }
    setBusy(true); setError(null)
    const row = {
      employee_id: employee.id,
      department: draft.department.trim(),
      dept_subcategory: draft.dept_subcategory.trim() || null,
      valid_from: draft.valid_from,
      valid_to: draft.valid_to || null,
      note: draft.note.trim() || null,
    }
    const { data, error: err } = draft.id
      ? await supabase.from('employee_cost_allocation').update(row).eq('id', draft.id).select('id')
      : await supabase.from('employee_cost_allocation').insert(row).select('id')
    setBusy(false)
    if (err) {
      setError(err.message.includes('no_overlap')
        ? 'Another allocation already covers part of that period. Two departments for '
          + 'one month would put the same salary in two places. End the old one first.'
        : `It could not be saved: ${err.message}`)
      return
    }
    if (!data || data.length === 0) { setError('The write was refused.'); return }
    setDraft(blank); onChanged()
  }

  const remove = async (r: CostAllocationRow) => {
    if (!window.confirm(
      `Delete the allocation from ${r.valid_from}? Months posted under it would no `
      + 'longer say where the cost went.')) return
    const { error: err } = await supabase.from('employee_cost_allocation')
      .delete().eq('id', r.id).select('id')
    if (err) { setError(`It could not be deleted: ${err.message}`); return }
    onChanged()
  }

  const chosenDept = departments.find(d => d.name === draft.department)
  const subsForDept = chosenDept
    ? subcategories.filter(c => c.department_id === chosenDept.id)
    : []

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.hintBox}>
        Five fields decide where a cost lands, and for a payroll only <b>one of them is
        about the person</b>: which department carries them. The rest follow from what
        the amount is. Without an allocation a posting refuses rather than letting the
        cost fall into Unassigned, where a salary looks like an ordinary cost of nobody.
      </div>

      <div style={s.chainBox}>
        <div style={s.chainTitle}>What will be booked for {employee.full_name}</div>
        {([
          ['Net salary', SUBCATEGORY.net],
          ['Income tax', SUBCATEGORY.tax],
          ['Contributions, employee', SUBCATEGORY.employee],
          ['Contributions, employer', SUBCATEGORY.employer],
        ] as const).map(([what, sub]) => (
          <div key={sub} style={s.chainRow}>
            <span style={s.chainWhat}>{what}</span>
            <span style={s.chainPath}>
              {PL_CATEGORY} &rsaquo; {sub} &rsaquo;{' '}
              <b style={{ color: draft.department ? '#00D47E' : '#C8A24A' }}>
                {draft.department || 'choose a department'}
              </b>
              {' '}&rsaquo; {draft.dept_subcategory || SALARY_DEPT_SUBCATEGORY}
              {' '}&rsaquo; {employee.full_name}
            </span>
          </div>
        ))}
        <div style={{ ...s.chainRow, borderTop: '0.5px solid rgba(255,255,255,0.08)', paddingTop: '7px' }}>
          <span style={s.chainWhat}>Other income</span>
          <span style={s.chainPath}>
            {PL_CATEGORY} &rsaquo; {OTHER_INCOME_SUBCATEGORY} &rsaquo;{' '}
            <b style={{ color: draft.department ? '#00D47E' : '#C8A24A' }}>
              {draft.department || 'choose a department'}
            </b>
            {' '}&rsaquo; {draft.dept_subcategory || SALARY_DEPT_SUBCATEGORY}
            {' '}&rsaquo; {employee.full_name}
          </span>
        </div>
        <div style={s.chainNote}>
          Projekti: the cost is shared over projects by the hours on each, entered on the
          timesheet under &ldquo;Sati po projektima&rdquo;; hours on no project, and paid
          absences, go to {OVERHEAD_LABEL}.
        </div>
        <div style={s.chainNote}>
          Only the department is a choice. The sub-category follows from what the amount
          is — an addition paid outside the salary lands in the same team, but not among
          the net salaries.
        </div>
      </div>

      {rows.length === 0 && (
        <div style={s.empty}>
          No allocation yet. Their organisational unit is
          {' '}<b>{employee.organisational_unit || 'not set'}</b>; map it on the Payroll
          page and every employee in it gets one, or set this person&rsquo;s here.
        </div>
      )}
      {rows.map(r => (
        <div key={r.id} style={{ ...s.card, ...(r.valid_to === null ? s.cardOpen : {}) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={s.cardTitle}>{r.valid_from} &rarr; {r.valid_to || 'indefinite'}</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button style={s.ghostSmall} onClick={() => setDraft({
                id: r.id, department: r.department, dept_subcategory: r.dept_subcategory || '',
                valid_from: r.valid_from, valid_to: r.valid_to || '', note: r.note || '',
              })}>Edit</button>
              <button className="mf-trash" title="Delete" aria-label="Delete" style={s.deleteBtn} onClick={() => remove(r)}>&#128465;</button>
            </div>
          </div>
          <div style={s.cardRow}>
            <b style={{ color: '#DCE9F6' }}>{r.department}</b>
            {r.dept_subcategory && <span>&middot; {r.dept_subcategory}</span>}
          </div>
          {r.note && <div style={s.cardNote}>{r.note}</div>}
        </div>
      ))}

      <div style={s.sectionLabel}>{draft.id ? 'Editing an allocation' : 'Add an allocation'}</div>
      <div style={s.grid}>
        <Field label="Department" hint="The one field that is about this person">
          <select style={s.input} value={draft.department}
            onChange={e => setDraft({ ...draft, department: e.target.value, dept_subcategory: '' })}>
            <option value="">— choose —</option>
            {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Sub-category"
          hint={`Normally ${SALARY_DEPT_SUBCATEGORY}`}>
          <select style={s.input} value={draft.dept_subcategory}
            disabled={!chosenDept}
            onChange={e => setDraft({ ...draft, dept_subcategory: e.target.value })}>
            <option value="">
              {chosenDept ? `— ${SALARY_DEPT_SUBCATEGORY} —` : 'choose a department first'}
            </option>
            {subsForDept.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="From">
          <input type="date" style={s.input} value={draft.valid_from}
            onChange={e => setDraft({ ...draft, valid_from: e.target.value })} />
        </Field>
        <Field label="Until" hint="Leave empty for indefinite">
          <input type="date" style={s.input} value={draft.valid_to}
            onChange={e => setDraft({ ...draft, valid_to: e.target.value })} />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Note">
            <input style={s.input} value={draft.note}
              onChange={e => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
        <button style={s.primary} onClick={save} disabled={busy}>
          {busy ? 'Saving...' : draft.id ? 'Save changes' : 'Add allocation'}
        </button>
        {draft.id && (
          <button style={s.ghost} onClick={() => { setDraft(blank); setError(null) }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

type TabKey = 'person' | 'contracts' | 'allocation' | 'absence' | 'deductions'

const TABS: [TabKey, string][] = [
  ['person', 'Person'],
  ['contracts', 'Salary'],
  ['allocation', 'Cost allocation'],
  ['absence', 'Off payroll'],
  ['deductions', 'Deductions'],
]

/**
 * Periods where somebody is employed but not ours to calculate or pay.
 *
 * Maternity leave above all: the state works it out and pays it. A month that
 * included them would be wrong by a whole person, in a direction nobody would
 * question — the figure would simply be there.
 *
 * NOT THE SAME AS LEAVING. The contract, the department and the deductions
 * all stay exactly where they are, ready for the month they come back. Using the leaving date for this would lose all of it and make the
 * return look like a new hire.
 */
function AbsenceTab({ employee, rows, onChanged }: {
  employee: EmployeeRow
  rows: AbsenceRow[]
  onChanged: () => void
}) {
  const blank = {
    id: '', reason: 'maternity' as AbsenceRow['reason'],
    valid_from: '', valid_to: '', note: '',
  }
  const [draft, setDraft] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!draft.valid_from) { setError('Say which date they come off the payroll.'); return }
    if (draft.valid_to && draft.valid_to <= draft.valid_from) {
      setError('The end date has to be after the start date.'); return
    }
    setBusy(true); setError(null)
    const row = {
      employee_id: employee.id,
      reason: draft.reason,
      valid_from: draft.valid_from,
      valid_to: draft.valid_to || null,
      note: draft.note.trim() || null,
    }
    const { data, error: err } = draft.id
      ? await supabase.from('employee_payroll_absence').update(row).eq('id', draft.id).select('id')
      : await supabase.from('employee_payroll_absence').insert(row).select('id')
    setBusy(false)
    if (err) {
      setError(err.message.includes('no_overlap')
        ? 'Another period already covers part of that. They would be off the payroll '
          + 'either way, but two rows give two different answers about why — and the why '
          + 'is what somebody reads and acts on.'
        : `It could not be saved: ${err.message}`)
      return
    }
    if (!data || data.length === 0) { setError('The write was refused.'); return }
    setDraft(blank); onChanged()
  }

  const remove = async (r: AbsenceRow) => {
    if (!window.confirm(
      `Delete the period from ${r.valid_from}? Those months would start calculating a `
      + 'salary this company does not pay.')) return
    const { error: err } = await supabase.from('employee_payroll_absence')
      .delete().eq('id', r.id).select('id')
    if (err) { setError(`It could not be deleted: ${err.message}`); return }
    onChanged()
  }

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <div style={s.hintBox}>
        For somebody who is still employed but whose salary is not ours to work out —
        maternity leave above all, where the state calculates and pays it. Those months
        produce no salary and no tax filing, and the person is listed on
        the payroll page as deliberately absent rather than simply missing.
        <div style={{ marginTop: '6px' }}>
          This is <b>not</b> the same as leaving. The contract, the department and every
          deduction stay exactly where they are, ready for the month they come back.
        </div>
      </div>

      {rows.length === 0 && <div style={s.empty}>On the payroll every month.</div>}
      {rows.map(r => (
        <div key={r.id} style={{ ...s.card, ...(r.valid_to === null ? s.cardOpen : {}) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={s.cardTitle}>
              {r.valid_from} &rarr; {r.valid_to || 'not back yet'}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button style={s.ghostSmall} onClick={() => setDraft({
                id: r.id, reason: r.reason, valid_from: r.valid_from,
                valid_to: r.valid_to || '', note: r.note || '',
              })}>Edit</button>
              <button className="mf-trash" title="Delete" aria-label="Delete" style={s.deleteBtn} onClick={() => remove(r)}>&#128465;</button>
            </div>
          </div>
          <div style={s.cardRow}>
            <b style={{ color: '#C8A24A' }}>{absenceLabel(r.reason)}</b>
          </div>
          {r.note && <div style={s.cardNote}>{r.note}</div>}
        </div>
      ))}

      <div style={s.sectionLabel}>{draft.id ? 'Editing a period' : 'Take them off the payroll'}</div>
      <div style={s.grid}>
        <Field label="Reason">
          <select style={s.input} value={draft.reason}
            onChange={e => setDraft({ ...draft, reason: e.target.value as AbsenceRow['reason'] })}>
            {ABSENCE_REASONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="From">
          <input type="date" style={s.input} value={draft.valid_from}
            onChange={e => setDraft({ ...draft, valid_from: e.target.value })} />
        </Field>
        <Field label="Back on"
          hint="Leave empty while they are still away">
          <input type="date" style={s.input} value={draft.valid_to}
            onChange={e => setDraft({ ...draft, valid_to: e.target.value })} />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Note">
            <input style={s.input} value={draft.note}
              onChange={e => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
        <button style={s.primary} onClick={save} disabled={busy}>
          {busy ? 'Saving...' : draft.id ? 'Save changes' : 'Add period'}
        </button>
        {draft.id && (
          <button style={s.ghost} onClick={() => { setDraft(blank); setError(null) }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * A labelled field.
 *
 * A `<label>` and not a `<div>`, which it was: the caption sat above the input
 * with nothing joining them, so a screen reader read a row of unnamed boxes
 * and clicking the caption did nothing. Wrapping the control associates them
 * without an id to keep in step, and it fixes every field in this dialog
 * rather than the one that happened to be noticed.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={s.label}>{label}</div>
      {children}
      {hint && <div style={s.hint}>{hint}</div>}
    </label>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px' },
  dialog: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '12px', width: '760px', maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' as const, fontFamily: "'Inter', system-ui, sans-serif", boxShadow: '0 20px 60px rgba(0,0,0,0.6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 22px 12px' },
  title: { fontFamily: "'DM Serif Display', Georgia, serif", fontSize: '20px', color: '#DCE9F6' },
  sub: { fontSize: '12px', color: '#7A9BB8', marginTop: '3px' },
  close: { background: 'none', border: 'none', color: '#7A9BB8', fontSize: '15px', cursor: 'pointer' },
  tabs: { display: 'flex', gap: '4px', padding: '0 22px', borderBottom: '1px solid rgba(255,255,255,0.075)' },
  tab: { background: 'none', border: 'none', borderBottom: '2px solid transparent', color: '#7A9BB8', fontSize: '13px', padding: '8px 12px', cursor: 'pointer' },
  tabOn: { color: '#00D47E', borderBottom: '2px solid #00D47E' },
  body: { padding: '18px 22px', overflowY: 'auto' as const, flex: 1 },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,0.075)' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' },
  label: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '5px' },
  hint: { fontSize: '11px', color: '#5C7894', marginTop: '4px' },
  input: { width: '100%', boxSizing: 'border-box' as const, fontFamily: 'system-ui,sans-serif', fontSize: '13px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '8px', padding: '8px 10px', background: '#060E1A', color: '#DCE9F6', outline: 'none' },
  checkLine: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#DCE9F6', padding: '8px 0' },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '9px 16px', fontSize: '13px', cursor: 'pointer' },
  danger: { background: 'none', color: '#FF5B5A', border: '1px solid rgba(255,91,90,0.35)', borderRadius: '8px', padding: '9px 16px', fontSize: '13px', cursor: 'pointer' },
  ghostSmall: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' },
  error: { margin: '0 22px 10px', background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.5 },
  hintBox: { background: 'rgba(78,168,255,0.07)', border: '1px solid rgba(78,168,255,0.20)', color: '#9BC4EC', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55, marginBottom: '14px' },
  sectionLabel: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', margin: '18px 0 8px' },
  empty: { color: '#5C7894', fontSize: '13px', padding: '10px 0' },
  card: { background: '#060E1A', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '9px', padding: '11px 13px', marginBottom: '8px' },
  cardOpen: { border: '1px solid rgba(0,212,126,0.30)' },
  cardOff: { opacity: 0.55, borderStyle: 'dashed' as const },
  offBanner: { margin: '0 22px 10px', background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55 },
  readOnly: { fontSize: '13px', color: '#DCE9F6', padding: '8px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' },
  chainBox: { background: '#060E1A', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '9px', padding: '11px 13px', marginBottom: '14px' },
  chainTitle: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '8px' },
  chainRow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '2px 0' },
  chainWhat: { fontSize: '11px', color: '#7A9BB8', minWidth: '150px' },
  chainPath: { fontSize: '11px', color: '#5C7894', lineHeight: 1.5 },
  chainNote: { fontSize: '10.5px', color: '#5C7894', marginTop: '8px', lineHeight: 1.5, fontStyle: 'italic' as const },
  cardEditing: { border: '1px solid rgba(78,168,255,0.45)', background: '#0A1626' },
  offBadge: { fontSize: '9px', fontWeight: '700', padding: '1px 6px', borderRadius: '20px', background: 'rgba(255,255,255,0.08)', color: '#7A9BB8', marginLeft: '8px' },
  cardTitle: { fontSize: '12px', color: '#7A9BB8', fontWeight: '600' },
  cardRow: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#7A9BB8', marginTop: '5px' },
  cardMeta: { fontSize: '11px', color: '#5C7894', marginTop: '4px' },
  cardNote: { fontSize: '11px', color: '#7A9BB8', marginTop: '5px', fontStyle: 'italic' as const },
  cardWarn: {
    fontSize: '11px', color: '#F5A623', marginTop: '6px', lineHeight: 1.4,
    background: 'rgba(245,166,35,0.10)', border: '0.5px solid rgba(245,166,35,0.28)',
    borderRadius: '7px', padding: '6px 9px',
  },
  badge: { fontSize: '11px', fontWeight: '500', padding: '3px 9px', borderRadius: '20px', whiteSpace: 'nowrap' as const },
  /**
   * The bin on every card in this dialog.
   *
   * It was 35% opacity with no colour of its own, which on these cards is
   * invisible — four tabs had a delete nobody could see. Opaque now, in the
   * same muted ink as the rest of the secondary text, and red under the
   * cursor so the destructive one announces itself before it is pressed.
   */
  deleteBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px',
    color: '#7A9BB8', padding: '2px 4px', lineHeight: 1, borderRadius: '5px',
  },
  cardAction: {
    fontFamily: "'Inter', system-ui, sans-serif", fontSize: '11px', fontWeight: 600,
    padding: '3px 10px', borderRadius: '6px', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)',
    color: '#7A9BB8', whiteSpace: 'nowrap',
  },
}
