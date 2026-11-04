// ─── Revenue classification: a project, a lease or sales of services ───────
//
// Every revenue invoice is exactly one of three things:
//
//   project   a site (or a building) billed to its investor
//   lease     rent, recognised from the lease: lease_id + service_month, on
//             the lease's own building (unique per lease and month in the
//             database, 20261008180000)
//   services  sales of services that belong to no project (project_id null)
//
// The rules that suggest one for an invoice we issued on SEF live here; the
// invoice dialog shows and saves the answer, and the person confirms it.

import type { DocumentType } from './documentType'
import type { Project } from './projects'
import { leaseMonthRent, monthKey, type PlanInvoice, type RentalLease } from './revenuePlan'
import { monthLabelLong } from './revenuePage'

export type RevenueKind = 'project' | 'lease' | 'services'

export const REVENUE_KIND_LABEL: Record<RevenueKind, string> = {
  project: 'Projekat',
  lease: 'Zakup',
  services: 'Prodaja usluga',
}

export function revenueKindOf(i: { lease_id?: string | null; project_id?: string | null }): RevenueKind {
  if (i.lease_id) return 'lease'
  if (i.project_id) return 'project'
  return 'services'
}

// ── The month a rent invoice is for ─────────────────────────────────────────

const MONTH_NAMES = ['januar', 'februar', 'mart', 'april', 'maj', 'jun', 'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar']
// Nominative (oktobar), genitive with the vowel kept (januara) and dropped (oktobra).
const MONTH_FORMS: [string, number][] = MONTH_NAMES.flatMap((n, i): [string, number][] => [
  [n, i], [`${n}a`, i], ...(n.endsWith('ar') ? [[`${n.slice(0, -2)}ra`, i] as [string, number]] : []),
]).sort((a, b) => b[0].length - a[0].length)
const NAMED_MONTH = new RegExp(String.raw`(?:^|[^a-z])(${MONTH_FORMS.map(f => f[0]).join('|')})\s+(\d{4})(?!\d)`)
// `10/2026`, `10.2026`; not the tail of a full date such as 31.10.2026.
const NUMBERED_MONTH = /(?:^|[^\d./])(\d{1,2})[./](\d{4})(?!\d)/

const fold = (text: string): string =>
  (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'dj')

const firstOf = (year: string, month: number): string | null =>
  month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, '0')}-01` : null

/** The month a text names (`zakup za oktobar 2026`, `oktobra 2026`, `10/2026`, `10.2026`) as `YYYY-MM-01`, or null. */
export function serviceMonthIn(text: string): string | null {
  const t = fold(text)
  const named = NAMED_MONTH.exec(t)
  if (named) return firstOf(named[2], MONTH_FORMS.find(f => f[0] === named[1])![1] + 1)
  const numbered = NUMBERED_MONTH.exec(t)
  if (numbered) return firstOf(numbered[2], Number(numbered[1]))
  return null
}

// ── A lease for the invoice ─────────────────────────────────────────────────

export interface LeaseProposal {
  leaseId: string
  projectId: string
  /** `YYYY-MM-01`. */
  serviceMonth: string
  /** A live invoice already exists for this lease and month. */
  alreadyBilled: boolean
  why: string
}

const near = (a: number, b: number | null): boolean => b !== null && Math.abs(a - b) <= 0.01

export function proposeLease(
  inv: { partnerId: string | null; net: number | null; gross: number | null; currency: string | null; date: string; text: string },
  leases: RentalLease[],
  invoices: PlanInvoice[],
): LeaseProposal | null {
  if (!inv.partnerId) return null
  const mine = leases.filter(l => l.active && l.tenant_partner_id === inv.partnerId)
  if (mine.length === 0) return null

  const fromText = serviceMonthIn(inv.text)
  const serviceMonth = fromText ?? `${monthKey(inv.date)}-01`
  const currency = inv.currency || 'RSD'

  const byAmount = mine.filter(l => {
    if (l.currency !== currency) return false
    const rent = leaseMonthRent(l, serviceMonth)
    return rent > 0 && (near(rent, inv.net) || near(rent, inv.gross))
  })

  const billed = (l: RentalLease) => invoices.some(i =>
    !i.deleted_at && i.lease_id === l.id && monthKey(i.service_month || '') === monthKey(serviceMonth))
  const proposal = (l: RentalLease, why: string): LeaseProposal =>
    ({ leaseId: l.id, projectId: l.project_id, serviceMonth, alreadyBilled: billed(l), why })

  const month = monthLabelLong(serviceMonth)
  if (byAmount.length === 1) {
    return proposal(byAmount[0], `Iznos je jednak zakupnini za ${month}${fromText ? '' : ' (mesec uzet iz datuma fakture)'}.`)
  }
  if (byAmount.length > 1) return null
  if (mine.length === 1 && fromText) {
    return proposal(mine[0], `Kupac ima jedan aktivan zakup, a faktura navodi ${month}.`)
  }
  return null
}

// ── A project for the invoice ───────────────────────────────────────────────

export interface ProjectProposal { projectId: string; why: string }

const HISTORY = 5

export function proposeProject(
  inv: { partnerId: string | null; number: string | null; text: string },
  projects: Project[],
  history: { partner_id: string | null; project_id: string | null; invoice_date: string | null; lease_id?: string | null }[],
): ProjectProposal | null {
  const active = projects.filter(p => p.active && p.kind === 'construction')

  // 1. The code or the name of a project in the number or the description.
  const haystack = fold(`${inv.number || ''} ${inv.text || ''}`)
  const named = active.filter(p => {
    const code = fold(p.code || '').trim()
    const name = fold(p.name || '').trim()
    return (code.length >= 2 && haystack.includes(code)) || (name.length >= 3 && haystack.includes(name))
  })
  if (named.length === 1) return { projectId: named[0].id, why: 'Šifra ili naziv projekta je na fakturi.' }

  if (!inv.partnerId) return null

  // 2. What this customer's last invoices went to (rent is not a project).
  const recent = history
    .filter(h => h.partner_id === inv.partnerId && !h.lease_id)
    .sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''))
    .slice(0, HISTORY)
  const tally = new Map<string, { n: number; latest: string }>()
  for (const h of recent) {
    if (!h.project_id || !active.some(p => p.id === h.project_id)) continue
    const t = tally.get(h.project_id)
    if (t) t.n += 1
    else tally.set(h.project_id, { n: 1, latest: h.invoice_date || '' })
  }
  let best: string | null = null
  for (const [id, t] of Array.from(tally.entries())) {
    const cur = best ? tally.get(best)! : null
    if (!cur || t.n > cur.n || (t.n === cur.n && t.latest > cur.latest)) best = id
  }
  if (best) return { projectId: best, why: 'Poslednje fakture ovog kupca idu na ovaj projekat.' }

  // 3. The only active site this customer is the investor of.
  const owned = active.filter(p => p.investor_partner_id === inv.partnerId)
  if (owned.length === 1) return { projectId: owned[0].id, why: 'Kupac je investitor jedinog aktivnog projekta.' }

  return null
}

// ── What stops the invoice from being saved ─────────────────────────────────

export function classificationProblem(
  c: { kind: RevenueKind | null; projectId: string | null; leaseId: string | null; serviceMonth: string | null },
  docType: DocumentType,
): string | null {
  if (!c.kind) return 'Izaberite: projekat, zakup ili prodaja usluga.'
  if (c.kind === 'lease' && docType !== 'invoice') {
    return 'Zakup se bira samo na računu; ovaj dokument ide na projekat zgrade.'
  }
  if (c.kind === 'project' && !c.projectId) return 'Izaberite projekat.'
  if (c.kind === 'lease' && (!c.leaseId || !c.serviceMonth)) return 'Izaberite zakup i mesec usluge.'
  return null
}
