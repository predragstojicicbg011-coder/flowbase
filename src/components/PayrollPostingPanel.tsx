import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import {
  planFor, checkPlan, planTotal, stornoTotal, unmappedUnits,
  type PostingPlan, type UnitMapping,
} from '../services/payroll/posting'
import { postPlan, undoPosting, fetchPostings, type PostContext } from '../services/payroll/post'
import { fetchHolidays, lastWorkingDayOf, type HolidayRow } from '../services/payroll/holidays'
import {
  matchEmployeesToPartners, unmatchedEmployees, matchEmployeeToPartner,
  matchPayeeToPartner, matchDeductionPartners, findTaxAuthority,
  classifyPostedNote, payrollMonthFromNote, personKey, TAX_AUTHORITY_NAME,
  type PartnerLike,
} from '../services/payroll/partnerMatch'
import type { PayrollRun } from '../services/payroll/runs'
import type { EmployeeForMonth } from '../services/payroll/employees'
import type { LedgerNames } from '../services/payroll/booking'
import type { SavedRun } from '../services/payroll/savedRuns'
import { fmtNum } from '../utils/formatters'
import { getBookRates } from '../services/bookAmounts'
import { fetchAllPartners } from '../services/allPartners'
/** Two names for one person, compared the way the matcher compares them. */
const personKeyEq = (a: string | null | undefined, b: string | null | undefined) =>
  !!personKey(a) && personKey(a) === personKey(b)

/**
 * Posting a month to the general ledger.
 *
 * NOTHING IS WRITTEN UNTIL IT HAS BEEN SHOWN. Each run gets a preview built by
 * the same function that does the writing, so what is on screen is what will
 * land — not a summary of it. A payroll posted wrong is not a wrong figure; it
 * is a second complete set of invoices that reconciles against nothing and has
 * to be unpicked by hand from a bank statement months later.
 *
 * The unit mapping is edited here rather than tucked into Settings, because
 * here is where somebody finds out it is missing. Being sent to another page
 * to fix a blocker is how a blocker becomes a habit of ignoring it.
 */
export default function PayrollPostingPanel({
  runs, people, month, companyId, exchangeRate, savedRuns, onPosted,
}: {
  runs: PayrollRun[]
  people: Record<string, EmployeeForMonth>
  month: string
  companyId: string
  /** RSD per EUR for the month, for euro-denominated deductions in the plan. */
  exchangeRate: number | null
  /** The kept calculations. Only a run that IS one can be posted. */
  savedRuns: SavedRun[]
  onPosted: () => void
}) {
  const [mapping, setMapping] = useState<UnitMapping[]>([])
  const [postings, setPostings] = useState<any[]>([])
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [showMapping, setShowMapping] = useState(false)
  const [ledger, setLedger] = useState<LedgerNames | null>(null)
  /**
   * The people in the partner book.
   *
   * Individuals only, because that flag is what stops `Nikola` the employee
   * being booked against `Nikola d.o.o.` the supplier — a salary on a
   * company's account, which looks perfectly ordinary in every report.
   */
  const [partners, setPartners] = useState<PartnerLike[]>([])
  /** The company calendar, for the month's last working day. */
  const [holidays, setHolidays] = useState<HolidayRow[]>([])
  /** Payroll rows already in the ledger with an empty Partner column. */
  type Posted = {
    id: string; note: string; parent_invoice_id: string | null
    partner_id: string | null; due_date: string | null; invoice_number: string | null
  }
  /** Payroll rows already in the ledger missing any of the three. */
  const [orphaned, setOrphaned] = useState<Posted[]>([])
  const [filling, setFilling] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [{ data: maps, error: mapErr }, posted, sub, dep, dsub, people_, days] = await Promise.all([
        supabase.from('payroll_unit_mapping').select('*').eq('company_id', companyId),
        fetchPostings(supabase, companyId, month),
        supabase.from('pl_subcategories').select('name'),
        supabase.from('departments').select('name'),
        supabase.from('dept_subcategories').select('name'),
        // THE WHOLE BOOK, and all of it. A payroll pays three kinds of
        // party — the employee, the tax authority and whoever a deduction is
        // forwarded to — and only the first of them is an individual.
        //
        // Paged, because this query had no order and no range: PostgREST
        // capped it at a thousand and the thousand were arbitrary, so an
        // employee past the cap was reported as not being in Partners at all.
        fetchAllPartners(supabase, 'id, name, is_individual'),
        fetchHolidays(supabase),
      ])
      if (mapErr) throw new Error(mapErr.message)
      setMapping(maps || [])
      setPostings(posted)
      setPartners(people_ as PartnerLike[])
      setHolidays(days as HolidayRow[])

      // ── What was posted before any of this existed ──────────────────
      //
      // Salary rows already in the ledger with no partner on them. Found by
      // the posting tag their note carries, so nothing else is touched: an
      // invoice typed by hand that happens to have no partner is somebody's
      // decision, not a gap to fill.
      const { data: gaps } = await supabase.from('invoices')
        .select('id, note, parent_invoice_id, partner_id, due_date, invoice_number')
        .eq('company_id', companyId)
        .like('note', '%[posting %')
        .or('partner_id.is.null,due_date.is.null,invoice_number.is.null')
      setOrphaned((gaps || []) as Posted[])
      setLedger({
        plSubcategories: (sub.data || []).map((r: any) => r.name),
        departments: (dep.data || []).map((r: any) => r.name),
        deptSubcategories: (dsub.data || []).map((r: any) => r.name),
      })
    } catch (e: any) {
      setError(e.message)
    }
  }, [companyId, month])

  useEffect(() => { if (companyId) reload() }, [companyId, reload])

  /** Everybody this month's runs pay, by employee id. */
  const staff = useMemo(() => {
    const seen = new Map<string, string>()
    for (const run of runs) {
      for (const l of run.salaries) seen.set(l.employeeId, l.name)
      for (const l of run.otherIncome) seen.set(l.employeeId, l.name)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [runs])

  const individuals = useMemo(
    () => partners.filter(p => p.is_individual === true), [partners])

  const employeePartners = useMemo(
    () => matchEmployeesToPartners(staff, individuals), [staff, individuals])

  /** Every deduction this month could forward, from the people being paid. */
  const allDeductions = useMemo(() => {
    const out: { id: string; goes_to?: string; payee?: string | null; label: string }[] = []
    for (const id of staff.map(e => e.id)) {
      for (const d of people[id]?.deductions ?? []) {
        out.push({ id: d.id, goes_to: d.goes_to, payee: d.payee, label: d.label })
      }
    }
    return out
  }, [staff, people])

  const deductionPartners = useMemo(
    () => matchDeductionPartners(allDeductions, partners), [allDeductions, partners])

  /**
   * The tax authority, found by NAME rather than held as a stored id.
   *
   * A stored id survives nothing — not a partner rebuilt, not a database
   * restored — and it is invisible when it goes stale: the obligation rows
   * simply post without a partner again. A name is matched fresh every time
   * and says so when it cannot be found.
   */
  const taxPartner = useMemo(() => findTaxAuthority(partners), [partners])

  /**
   * Who could not be matched, and why — said BEFORE the posting, because
   * afterwards the fix is editing ledger rows one at a time.
   *
   * It does not block: a salary with no partner is a correct salary with a
   * blank to fill in, and refusing to post the month over a missing partner
   * record would be worse than the gap it is complaining about.
   */
  const unmatched = useMemo(
    () => unmatchedEmployees(staff, individuals), [staff, individuals])

  /** The deduction payees that could not be placed, named once each. */
  const unmatchedPayees = useMemo(() => {
    const seen = new Map<string, string>()
    for (const d of allDeductions) {
      if (d.goes_to !== 'third_party') continue
      const payee = (d.payee || '').trim()
      if (!payee) { seen.set(d.label, `${d.label} — the deduction names no payee at all`); continue }
      const m = matchPayeeToPartner(payee, partners)
      if (m.partnerId) continue
      seen.set(payee, m.reason === 'ambiguous'
        ? `${payee} — more than one partner answers to that, so choosing would be a coin toss`
        : `${payee} — nobody of that name is in Partners`)
    }
    return [...seen.values()]
  }, [allDeductions, partners])

  const plans = useMemo(() => {
    const out: Record<string,
      { plan: PostingPlan; why: string | null; missing: string[]; runId: string | null }> = {}
    for (const run of runs) {
      if (run.salaries.length === 0 && run.otherIncome.length === 0) continue
      const plan = planFor({
        run, month, people, mapping,
        employeePartners,
        deductionPartners,
        taxPartnerId: taxPartner.partnerId,
        currencyRates: exchangeRate ? { EUR: exchangeRate } : {},
      })
      // WHAT LANDS IN THE LEDGER HAS TO BE THE THING THAT WAS KEPT. The only
      // way to be sure is to insist the two agree at the moment of posting:
      // if an input has moved since the last calculation they will not, and
      // Recalculate is the answer rather than a silent choice between two
      // versions of the month.
      const kept = savedRuns.find(r => r.run_key === run.key)
      const notKept = !kept
        ? 'This run has not been calculated and kept yet. Press Recalculate above — what '
          + 'is posted has to be a record, not something worked out on the way past.'
        : Math.abs(Number(kept.total_cost) - run.totals.totalCost) > 0.02
          ? `What is kept for this run says ${Number(kept.total_cost).toFixed(2)} and it now `
            + `comes to ${run.totals.totalCost.toFixed(2)}. Something behind it has changed; `
            + 'recalculate before posting so the ledger and the record agree.'
          : null

      out[run.key] = {
        plan,
        why: notKept ?? checkPlan(plan, ledger ?? undefined),
        missing: unmappedUnits(run, people, mapping),
        runId: kept?.id ?? null,
      }
    }
    return out
  }, [runs, month, people, mapping, exchangeRate, ledger, savedRuns,
      employeePartners, deductionPartners, taxPartner])

  /**
   * The already-posted rows this can put a partner on, by the SAME matcher
   * that a new posting uses.
   *
   * Reusing it is the point. The alternative was a second rule written in
   * SQL, and two spellings of "is this the same person" is one of them being
   * wrong about somebody eventually.
   */
  const fillable = useMemo(() => {
    // The obligation legs carry the sub-category in their note rather than
    // anything nameable, so they are recognised by their PARENT: the row that
    // says "Tax and contributions" is the parent, and its children are the
    // tax and the two contribution lines.
    const taxParents = new Set(
      orphaned.filter(r => classifyPostedNote(r.note).kind === 'tax').map(r => r.id))

    const out: { id: string; patch: Record<string, string> }[] = []
    for (const row of orphaned) {
      const what = classifyPostedNote(row.note)
      const patch: Record<string, string> = {}

      if (!row.partner_id) {
        let partnerId: string | null = null
        if (what.kind === 'employee') {
          partnerId = matchEmployeeToPartner(what.name, individuals).partnerId
        } else if (what.kind === 'tax' || (row.parent_invoice_id && taxParents.has(row.parent_invoice_id))) {
          partnerId = taxPartner.partnerId
        } else if (what.kind === 'deduction') {
          // The note names the deduction and the person, which is enough to
          // find the arrangement in HR and read its payee off it — rather
          // than guessing a company out of a label somebody chose for their
          // own use.
          const owner = staff.find(e => personKeyEq(e.name, what.employee))
          const d = (owner ? people[owner.id]?.deductions ?? [] : [])
            .find(x => x.label === what.label)
          partnerId = d
            ? (d.payee_partner_id && partners.some(p => p.id === d.payee_partner_id)
              ? d.payee_partner_id
              : matchPayeeToPartner(d.payee, partners).partnerId)
            : null
        }
        if (partnerId) patch.partner_id = partnerId
      }

      // The month comes off the ROW, not off the screen. A September run
      // written up in October falls due in September, and using the open
      // month would date an August row in October unquestionably.
      const rowMonth = payrollMonthFromNote(row.note)
      if (rowMonth) {
        if (!row.due_date) patch.due_date = lastWorkingDayOf(rowMonth, holidays)
        if (!row.invoice_number) patch.invoice_number = rowMonth
      }

      if (Object.keys(patch).length > 0) out.push({ id: row.id, patch })
    }
    return out
  }, [orphaned, individuals, partners, taxPartner, staff, people, holidays])

  const fillPartners = async () => {
    setFilling(true); setError(null); setDone(null)
    let filled = 0
    for (const row of fillable) {
      const { error: err } = await supabase.from('invoices')
        .update(row.patch).eq('id', row.id).select('id')
      if (err) {
        setFilling(false)
        setError(`Filled ${filled} before stopping: ${err.message}`)
        reload()
        return
      }
      filled += 1
    }
    setFilling(false)
    setDone(`${filled} posted row${filled === 1 ? '' : 's'} completed — partner, due date `
      + 'and invoice number, only where they were empty. No amount or classification '
      + 'was touched.')
    reload()
  }

  const postedFor = (key: string) => postings.find(p => p.run_key === key) || null

  const post = async (run: PayrollRun) => {
    const entry = plans[run.key]
    if (!entry || entry.why) return
    setBusy(run.key); setError(null); setDone(null)
    // Payroll is booked in dinars; every row carries its euro figure beside
    // them at the NBS rate of the payment date. Entries written with no EUR
    // rate would be correct in dinars and missing from every report read in
    // euros, which reads as a month that simply cost less — so without the
    // rate nothing is posted.
    let eurRate: number
    try {
      eurRate = (await getBookRates(paymentDate)).eurRate
    } catch (e: any) {
      setError(`The NBS euro rate for ${paymentDate} could not be read, so nothing was posted. `
        + `(${e?.message || String(e)}) Every entry would go in without its EUR figure and `
        + 'would be missing from the reports read in euros.')
      setBusy(null)
      return
    }
    const context: PostContext = {
      companyId, paymentDate,
      // The month being posted, not the month it is being posted in. A run
      // for September written up in October falls due in September, which is
      // the period the obligation belongs to.
      dueDate: lastWorkingDayOf(month, holidays),
      invoiceNumber: month,
      currency: 'RSD',
      eurRate,
      // Posting freezes this run, so a recalculation cannot move underneath
      // the invoices it just wrote.
      runId: entry.runId,
      note: `Payroll ${month} — ${run.label}`,
    }
    try {
      await postPlan(supabase, entry.plan, context, run.label)
      setDone(`${run.label} posted — ${entry.plan.invoices.length} invoices`
        + (entry.plan.transactions.length ? ` and ${entry.plan.transactions.length} storno entries` : ''))
      await reload()
      onPosted()
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(null)
  }

  const undo = async (run: PayrollRun) => {
    const posting = postedFor(run.key)
    if (!posting) return
    const n = (posting.created_invoice_ids?.length || 0) + (posting.created_transaction_ids?.length || 0)
    if (!window.confirm(
      `Remove the ${n} entries ${run.label} created for ${month}? Any of them already `
      + 'matched to a bank payment will lose that link.')) return
    setBusy(run.key); setError(null); setDone(null)
    try {
      await undoPosting(supabase, posting)
      setDone(`${run.label} was undone — ${n} entries removed`)
      await reload()
      onPosted()
    } catch (e: any) {
      setError(e.message)
    }
    setBusy(null)
  }

  const money = (n: number) => fmtNum(n)

  const allMissing = useMemo(() => {
    const set = new Set<string>()
    for (const e of Object.values(plans)) e.missing.forEach(u => set.add(u))
    return [...set].sort()
  }, [plans])

  if (!companyId) {
    return (
      <div style={s.panel}>
        <div style={s.title}>Post to the ledger</div>
        <div style={s.hint}>
          Choose a single company above. A posting belongs to one set of books, and
          "all companies" does not say which.
        </div>
      </div>
    )
  }

  return (
    <div style={s.panel}>
      <div style={s.head}>
        <div>
          <div style={s.title}>Post to the ledger</div>
          <div style={s.hint}>
            Each run posts once. What is listed below is exactly what will be written —
            built by the same function that writes it.
          </div>
        </div>
        <label style={s.dateLabel}>
          <span style={s.dateCaption}>Payment date</span>
          <input type="date" style={s.input} value={paymentDate}
            onChange={e => setPaymentDate(e.target.value)} />
        </label>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {done && <div style={s.ok}>{done}</div>}

      {allMissing.length > 0 && (
        <div style={s.warn}>
          <b>{allMissing.length} organisational {allMissing.length === 1 ? 'unit has' : 'units have'} no
          department.</b> Nothing can be posted until they do — every entry would fall into
          Unassigned, where a salary looks like an ordinary cost of nobody.
          <button style={{ ...s.ghostSmall, marginLeft: '8px' }}
            onClick={() => setShowMapping(v => !v)}>
            {showMapping ? 'Hide' : 'Map them now'}
          </button>
        </div>
      )}

      {showMapping && (
        <UnitMappingEditor companyId={companyId} units={allMissing}
          existing={mapping} onChanged={reload} />
      )}

      {/* SAID BEFORE THE POSTING, because afterwards the fix is editing ledger
          rows one at a time. It does not block: a salary with no partner is a
          correct salary with a blank to fill in, and refusing to post a month
          over a missing partner record would be worse than the gap. */}
      {/* The tax authority is one partner for every obligation row on every
          run, so it gets its own line: one missing record leaves the biggest
          figures on the posting with an empty Partner column. */}
      {!taxPartner.partnerId && (
        <div style={s.warn}>
          <b>The tax authority is not in Partners.</b> The tax and contribution rows will
          post without one. Add a partner named <i>{TAX_AUTHORITY_NAME}</i>
          {taxPartner.reason === 'ambiguous'
            ? ' — more than one partner answers to that name, so choosing would be a coin toss.'
            : ' and it will be found by name from then on.'}
        </div>
      )}

      {unmatchedPayees.length > 0 && (
        <div style={s.warn}>
          <b>{unmatchedPayees.length} deduction {unmatchedPayees.length === 1 ? 'payee' : 'payees'}</b>
          {' '}could not be placed, so those forwarded amounts post without a partner. The payee is
          read off the administrative deduction in HR Administration.
          <div style={{ marginTop: '6px', fontWeight: 400 }}>
            {unmatchedPayees.map(line => <div key={line}>{line}</div>)}
          </div>
        </div>
      )}

      {unmatched.length > 0 && (
        <div style={s.warn}>
          <b>{unmatched.length} {unmatched.length === 1 ? 'person has' : 'people have'} no
          partner record</b>, so their rows will be written without one. Everything else
          about them posts normally.
          <div style={{ marginTop: '6px', fontWeight: 400 }}>
            {unmatched.map(u => (
              <div key={u.id}>
                {u.name} — {
                  u.reason === 'not_individual'
                    ? 'a partner of that name exists but is filed as a company. '
                      + 'Tick “Individual” on it in Partners and it will match.'
                  : u.reason === 'ambiguous'
                    ? 'two individuals carry that name, so choosing between them '
                      + 'would be a coin toss. Merge or rename one of them.'
                    : 'nobody of that name is in Partners. Add them as an individual.'
                }
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The rows that went in before payroll knew about partners. Offered
          rather than done on load: it writes to the ledger, and a page that
          edits posted rows on arrival is a page nobody can trust. */}
      {fillable.length > 0 && (
        <div style={s.warn}>
          <b>{fillable.length} posted {fillable.length === 1 ? 'row' : 'rows'}</b> can be
          completed — the partner (salaries to the person, tax to the tax authority, forwarded
          deductions to their payee), the due date, and the invoice number. Each is written only
          where it is empty, and no amount or classification is touched.
          <button style={{ ...s.ghostSmall, marginLeft: '8px' }}
            onClick={fillPartners} disabled={filling}>
            {filling ? 'Filling…' : 'Fill them in'}
          </button>
        </div>
      )}

      {Object.keys(plans).length === 0 && (
        <div style={s.hint}>Nothing to post for this month.</div>
      )}

      {runs.map(run => {
        const entry = plans[run.key]
        if (!entry) return null
        const posting = postedFor(run.key)
        const storno = stornoTotal(entry.plan)
        return (
          <div key={run.key} style={s.row}>
            <div style={{ flex: 1 }}>
              <div style={s.runName}>
                {run.label}
                {posting && <span style={s.postedBadge}>Posted {posting.posted_on}</span>}
              </div>
              <div style={s.runDetail}>
                {entry.plan.invoices.filter(i => i.kind === 'net').length} net salary,{' '}
                {entry.plan.invoices.filter(i => i.kind === 'third_party').length} forwarded,{' '}
                {entry.plan.invoices.filter(i => i.kind === 'other_income').length} other income,{' '}
                {entry.plan.invoices.filter(i => i.kind === 'obligation_child').length} tax rows
                {entry.plan.transactions.length > 0 && `, ${entry.plan.transactions.length} storno`}
                {' · '}<b style={{ color: '#DCE9F6' }}>{money(planTotal(entry.plan))}</b>
                {storno !== 0 && (
                  <span style={{ color: '#7A9BB8' }}>
                    {' '}and {money(storno)} cancelled elsewhere
                  </span>
                )}
              </div>
              {entry.why && <div style={s.blocked}>{entry.why}</div>}
            </div>
            <div>
              {posting ? (
                <button style={s.ghost} disabled={busy === run.key} onClick={() => undo(run)}>
                  {busy === run.key ? 'Removing…' : 'Undo'}
                </button>
              ) : (
                <button style={entry.why ? s.disabled : s.primary}
                  disabled={!!entry.why || busy === run.key}
                  title={entry.why || undefined}
                  onClick={() => post(run)}>
                  {busy === run.key ? 'Posting…' : 'Post'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Mapping an organisational unit to a department.
 *
 * Free text rather than a dropdown of existing departments, because the
 * department list lives in the ledger's own data and a wrong dropdown is
 * harder to notice than a wrong word. What is typed here is matched exactly,
 * so it is shown back on every row.
 */
function UnitMappingEditor({ companyId, units, existing, onChanged }: {
  companyId: string
  units: string[]
  existing: UnitMapping[]
  onChanged: () => void
}) {
  const [draft, setDraft] = useState<Record<string, { department: string; sub: string }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const all = useMemo(() => {
    const set = new Set<string>(units)
    existing.forEach(m => set.add(m.organisational_unit))
    return [...set].sort()
  }, [units, existing])

  const valueFor = (unit: string) => {
    if (draft[unit]) return draft[unit]
    const found = existing.find(m => m.organisational_unit === unit)
    return { department: found?.department || '', sub: found?.dept_subcategory || '' }
  }

  const save = async () => {
    setBusy(true); setError(null)
    const rows = all
      .map(unit => ({ unit, ...valueFor(unit) }))
      .filter(r => r.department.trim())
      .map(r => ({
        company_id: companyId,
        organisational_unit: r.unit,
        department: r.department.trim(),
        dept_subcategory: r.sub.trim() || null,
        updated_at: new Date().toISOString(),
      }))
    if (rows.length === 0) { setBusy(false); setError('Give at least one unit a department.'); return }

    const { data, error: err } = await supabase
      .from('payroll_unit_mapping')
      .upsert(rows, { onConflict: 'company_id,organisational_unit' })
      .select('id')
    if (err) { setBusy(false); setError(`The mapping could not be saved: ${err.message}`); return }
    if (!data || data.length === 0) {
      setBusy(false)
      setError('Nothing was saved and the database reported no error, which usually '
        + 'means the write was refused.')
      return
    }

    // GIVE EVERYBODY IN THOSE UNITS AN ALLOCATION OF THEIR OWN.
    //
    // Without this the mapping would not do what it looks like it does: a
    // posting would find the department through the mapping and work, while
    // every employee screen went on saying "not allocated". Two mechanisms
    // that disagree about the same question, one of them invisible.
    //
    // Only for people who have none — an allocation somebody set by hand is
    // a decision about that person and the team's answer must not overrule it.
    const { data: people } = await supabase
      .from('employees')
      .select('id, hired_on, organisational_unit')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .in('organisational_unit', rows.map(r => r.organisational_unit))

    const { data: existing } = await supabase
      .from('employee_cost_allocation')
      .select('employee_id')
      .in('employee_id', (people || []).map((p: any) => p.id))

    const already = new Set((existing || []).map((a: any) => a.employee_id))
    const toCreate = (people || [])
      .filter((p: any) => !already.has(p.id))
      .map((p: any) => {
        const m = rows.find(r => r.organisational_unit === p.organisational_unit)!
        return {
          employee_id: p.id,
          department: m.department,
          dept_subcategory: m.dept_subcategory,
          valid_from: p.hired_on || '2026-01-01',
          note: 'From the organisational unit mapping. Change it on the employee '
            + 'if this person costs a different department than their unit does.',
        }
      })

    if (toCreate.length > 0) {
      const { error: allocErr } = await supabase
        .from('employee_cost_allocation').insert(toCreate).select('id')
      if (allocErr) {
        setBusy(false)
        setError(`The mapping was saved, but ${toCreate.length} employees did not get an `
          + `allocation from it (${allocErr.message}). Set theirs on the employee, or `
          + 'save this again.')
        onChanged()
        return
      }
    }

    setBusy(false)
    setDraft({})
    onChanged()
  }

  return (
    <div style={s.mapBox}>
      <div style={s.mapHead}>Organisational unit → department</div>
      {all.map(unit => {
        const v = valueFor(unit)
        return (
          <div key={unit} style={s.mapRow}>
            <div style={s.mapUnit}>{unit}</div>
            <input style={s.input} placeholder="Department" value={v.department}
              onChange={e => setDraft(d => ({ ...d, [unit]: { ...v, department: e.target.value } }))} />
            <input style={s.input} placeholder="Sub-category" value={v.sub}
              onChange={e => setDraft(d => ({ ...d, [unit]: { ...v, sub: e.target.value } }))} />
          </div>
        )
      })}
      {error && <div style={s.error}>{error}</div>}
      <button style={s.primary} onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save the mapping'}
      </button>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '10px', padding: '16px 18px', marginBottom: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px', marginBottom: '12px' },
  title: { fontSize: '15px', fontWeight: '600', color: '#DCE9F6' },
  hint: { fontSize: '11px', color: '#7A9BB8', marginTop: '4px', maxWidth: '560px', lineHeight: 1.5 },
  dateLabel: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  dateCaption: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em' },
  row: { display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '11px 0', borderTop: '0.5px solid rgba(255,255,255,0.06)' },
  runName: { fontSize: '13px', fontWeight: '600', color: '#DCE9F6', display: 'flex', alignItems: 'center', gap: '8px' },
  runDetail: { fontSize: '11px', color: '#7A9BB8', marginTop: '3px', lineHeight: 1.5 },
  blocked: { fontSize: '11px', color: '#FF8E8D', marginTop: '5px', lineHeight: 1.45, maxWidth: '640px' },
  postedBadge: { fontSize: '9px', fontWeight: '700', padding: '2px 7px', borderRadius: '20px', background: 'rgba(0,212,126,0.13)', color: '#00D47E' },
  input: { fontFamily: 'system-ui,sans-serif', fontSize: '12px', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '7px', padding: '7px 9px', background: '#060E1A', color: '#DCE9F6', outline: 'none', minWidth: '140px' },
  primary: { background: '#00D47E', color: '#060E1A', border: 'none', borderRadius: '8px', padding: '8px 18px', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  disabled: { background: 'rgba(255,255,255,0.06)', color: '#5C7894', border: 'none', borderRadius: '8px', padding: '8px 18px', fontSize: '12px', cursor: 'not-allowed' },
  ghost: { background: 'none', color: '#7A9BB8', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '8px 16px', fontSize: '12px', cursor: 'pointer' },
  ghostSmall: { background: 'none', color: 'inherit', border: '1px solid currentColor', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' },
  error: { background: 'rgba(255,91,90,0.10)', border: '1px solid rgba(255,91,90,0.30)', color: '#FF8E8D', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55, marginBottom: '10px' },
  warn: { background: 'rgba(200,162,74,0.10)', border: '1px solid rgba(200,162,74,0.30)', color: '#D8B96A', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', lineHeight: 1.55, marginBottom: '10px' },
  ok: { background: 'rgba(0,212,126,0.08)', border: '1px solid rgba(0,212,126,0.28)', color: '#00D47E', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', marginBottom: '10px' },
  mapBox: { background: '#060E1A', border: '1px solid rgba(255,255,255,0.075)', borderRadius: '9px', padding: '12px 14px', marginBottom: '12px' },
  mapHead: { fontSize: '10px', fontWeight: '600', color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginBottom: '10px' },
  mapRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '7px' },
  mapUnit: { fontSize: '12px', color: '#7A9BB8', flex: 1, minWidth: '200px' },
}
