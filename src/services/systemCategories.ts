// ─── System categories ──────────────────────────────────────────────────────
//
// Where the app books what it books on its own: payroll, credit instalments,
// and the two lines the cash flow page singles out.
//
// Mintflow found those headings by their English names ('Employee and Labour'
// › 'Net Salaries', 'Loans/Credits/Dividend' › 'Bank Credits', 'Banking and
// Finance', 'Taxes'). FlowBase's owner builds his own P&L in Serbian, so none of
// those names exists here. Instead, each automatic posting has a ROLE, and
// the table `system_categories` (one row per company and role) says which of
// the owner's headings that role posts to.
//
// THE RULE: an unset role is refused, never guessed. `classificationFor`
// throws `SystemCategoryMissing` with a message that says where to set it;
// posting code lets that stop the write. A posting under an empty or an
// English heading is worse than no posting — it is a second heading beside
// the real one that the P&L then shows with part of the money in it.
//
// NAMES, NOT IDS. Transactions, invoices and pl_splits store the
// classification as text, and what is stored here is exactly what is copied
// onto them.
//
// Schema: supabase/migrations/20261008200000_system_categories.sql.

export type ClassField =
  | 'pl_category' | 'pl_subcategory' | 'department' | 'dept_subcategory' | 'expense_description'

export const CLASS_FIELDS: readonly ClassField[] = [
  'pl_category', 'pl_subcategory', 'department', 'dept_subcategory', 'expense_description',
]

export const FIELD_LABEL: Readonly<Record<ClassField, string>> = {
  pl_category: 'P&L kategorija',
  pl_subcategory: 'P&L potkategorija',
  department: 'Sektor',
  dept_subcategory: 'Podsektor',
  expense_description: 'Opis troška',
}

/** A classification as transactions and invoices carry it. */
export interface Classification {
  pl_category: string | null
  pl_subcategory: string | null
  department: string | null
  dept_subcategory: string | null
  expense_description: string | null
}

export const EMPTY_CLASSIFICATION: Classification = {
  pl_category: null, pl_subcategory: null, department: null,
  dept_subcategory: null, expense_description: null,
}

export type SystemRole =
  | 'payroll_net_salary'
  | 'payroll_income_tax'
  | 'payroll_employee_contributions'
  | 'payroll_employer_contributions'
  | 'payroll_other_income'
  | 'payroll_salary_dept_subcategory'
  | 'payroll_retained_fallback'
  | 'payroll_fitpass'
  | 'payroll_health_insurance'
  | 'payroll_penalty'
  | 'credit_principal'
  | 'credit_interest'
  | 'cashflow_banking'
  | 'cashflow_taxes'

export type RoleGroup = 'payroll' | 'credit' | 'cashflow'

export const ROLE_GROUP_LABEL: Readonly<Record<RoleGroup, string>> = {
  payroll: 'Zarade',
  credit: 'Krediti',
  cashflow: 'Novčani tok',
}

export interface SystemRoleDef {
  role: SystemRole
  group: RoleGroup
  /** Serbian name of the role, as the settings tab and every error say it. */
  label: string
  /** What gets booked there. */
  description: string
  /** The fields this role fills — and therefore the ones that must be set. */
  fields: readonly ClassField[]
}

const PL: readonly ClassField[] = ['pl_category', 'pl_subcategory']
const ALL: readonly ClassField[] = CLASS_FIELDS

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    role: 'payroll_net_salary', group: 'payroll', label: 'Neto zarade', fields: PL,
    description: 'Neto zarada svakog zaposlenog i obustave koje se prosleđuju trećem licu '
      + '(npr. rata kredita). Sektor i podsektor dolaze iz raspodele zaposlenog.',
  },
  {
    role: 'payroll_income_tax', group: 'payroll', label: 'Porez na zarade', fields: PL,
    description: 'Porez na zarade po zaposlenom, i zbirna obaveza prema Poreskoj upravi '
      + 'sa kojom se uparuje plaćanje.',
  },
  {
    role: 'payroll_employee_contributions', group: 'payroll', label: 'Doprinosi na teret zaposlenog',
    fields: PL,
    description: 'PIO, zdravstveno i nezaposlenost koji se odbijaju od bruto zarade zaposlenog.',
  },
  {
    role: 'payroll_employer_contributions', group: 'payroll', label: 'Doprinosi na teret poslodavca',
    fields: PL,
    description: 'Doprinosi koje firma plaća povrh bruto zarade.',
  },
  {
    role: 'payroll_other_income', group: 'payroll', label: 'Ostala primanja', fields: PL,
    description: 'Primanja isplaćena van zarade (nagrade, naknade). Pod sektorom zaposlenog, '
      + 'ali ne među neto zaradama.',
  },
  {
    role: 'payroll_salary_dept_subcategory', group: 'payroll', label: 'Podsektor za zarade',
    fields: ['dept_subcategory'],
    description: 'Podsektor pod kojim se knjiže zarade kada raspodela zaposlenog ne navodi '
      + 'svoj. Isti naziv treba da postoji pod svakim sektorom koji nosi zarade.',
  },
  {
    role: 'payroll_retained_fallback', group: 'payroll', label: 'Zadržane obustave (ostalo)', fields: PL,
    description: 'Storno za obustavu koju firma zadržava, a za koju nema posebne kategorije. '
      + 'Napomena na stavci navodi obustavu, pa se može kasnije premestiti.',
  },
  {
    role: 'payroll_fitpass', group: 'payroll', label: 'FitPass', fields: ALL,
    description: 'Trošak FitPass članarine i storno kada se članarina zadrži od zarade '
      + '(obustava čiji naziv počinje sa „Fitpass“).',
  },
  {
    role: 'payroll_health_insurance', group: 'payroll', label: 'Privatno zdravstveno osiguranje',
    fields: PL,
    description: 'Storno za zadržano privatno zdravstveno osiguranje (obustave „Privatno '
      + 'zdravstveno osiguranje …“ i „Osigurani članovi porodice …“).',
  },
  {
    role: 'payroll_penalty', group: 'payroll', label: 'Kazne', fields: ALL,
    description: 'Storno za kazne zadržane od zarade (ručni unos zarada).',
  },
  {
    role: 'credit_principal', group: 'credit', label: 'Otplata glavnice kredita', fields: ALL,
    description: 'Deo rate kredita koji otplaćuje glavnicu, kada se izvod upari sa ratom.',
  },
  {
    role: 'credit_interest', group: 'credit', label: 'Kamata na kredit', fields: ALL,
    description: 'Deo rate kredita koji je kamata, kada se izvod upari sa ratom.',
  },
  {
    role: 'cashflow_banking', group: 'cashflow',
    label: 'Bankarske provizije i troškovi finansiranja', fields: ['pl_category'],
    description: 'P&L kategorija koju Novčani tok prikazuje kao finansijske odlive, odvojeno '
      + 'od poslovnih.',
  },
  {
    role: 'cashflow_taxes', group: 'cashflow', label: 'Porezi', fields: ['pl_category'],
    description: 'P&L kategorija koju Novčani tok prikazuje kao poreske odlive, odvojeno '
      + 'od poslovnih.',
  },
]

/** What `payroll` posting always needs, whatever the month holds. */
export const PAYROLL_ROLES: readonly SystemRole[] = [
  'payroll_net_salary', 'payroll_income_tax',
  'payroll_employee_contributions', 'payroll_employer_contributions',
]

export const CREDIT_ROLES: readonly SystemRole[] = ['credit_principal', 'credit_interest']

/** Where the user sets them, as every message says it. */
export const SETTINGS_PATH = 'Podešavanja → Sistemske kategorije'

export type SystemCategoryMap = Partial<Record<SystemRole, Classification>>

export function roleDef(role: SystemRole): SystemRoleDef {
  const d = SYSTEM_ROLES.find(r => r.role === role)
  if (!d) throw new Error(`Nepoznata sistemska kategorija: ${role}`)
  return d
}

const filled = (v: string | null | undefined): v is string => !!(v && v.trim())

/** Every field the role needs has a value. */
export function isRoleSet(role: SystemRole, map: SystemCategoryMap | null | undefined): boolean {
  const c = map?.[role]
  if (!c) return false
  return roleDef(role).fields.every(f => filled(c[f]))
}

/** The roles among `roles` that are not set, in the order given. */
export function missingRoles(
  roles: readonly SystemRole[], map: SystemCategoryMap | null | undefined,
): SystemRole[] {
  return roles.filter(r => !isRoleSet(r, map))
}

export function missingMessage(role: SystemRole): string {
  return `Sistemska kategorija „${roleDef(role).label}“ nije podešena. `
    + `Podesite je u ${SETTINGS_PATH}.`
}

/** The labels of the roles, quoted and joined, for a notice. */
export function roleLabels(roles: readonly SystemRole[]): string {
  return roles.map(r => `„${roleDef(r).label}“`).join(', ')
}

export class SystemCategoryMissing extends Error {
  constructor(public role: SystemRole) {
    super(missingMessage(role))
    this.name = 'SystemCategoryMissing'
  }
}

/**
 * The classification a role posts to, or a throw.
 *
 * Only the role's own fields are returned filled (trimmed); the others are
 * null, so spreading the result onto a row never carries a stale value from a
 * field the role does not own.
 */
export function classificationFor(
  role: SystemRole, map: SystemCategoryMap | null | undefined,
): Classification {
  if (!isRoleSet(role, map)) throw new SystemCategoryMissing(role)
  const c = map![role]!
  const out: Classification = { ...EMPTY_CLASSIFICATION }
  for (const f of roleDef(role).fields) out[f] = (c[f] as string).trim()
  return out
}

/** The P&L half of a role — what payroll writes beside the person's department. */
export function plPartFor(
  role: SystemRole, map: SystemCategoryMap | null | undefined,
): { pl_category: string; pl_subcategory: string } {
  const c = classificationFor(role, map)
  if (!filled(c.pl_category) || !filled(c.pl_subcategory)) throw new SystemCategoryMissing(role)
  return { pl_category: c.pl_category, pl_subcategory: c.pl_subcategory }
}

/**
 * The `classificationFor` of a role as a non-throwing lookup: the
 * classification, or null when it is unset. For readers (a report filter, a
 * preview), never for a write.
 */
export function classificationOrNull(
  role: SystemRole, map: SystemCategoryMap | null | undefined,
): Classification | null {
  return isRoleSet(role, map) ? classificationFor(role, map) : null
}

// ── Reading and writing ────────────────────────────────────────────────────

export interface SystemCategoryRow extends Classification {
  id?: string
  company_id: string
  role: string
}

const KNOWN = new Set<string>(SYSTEM_ROLES.map(r => r.role))

/** Rows → map. Unknown roles are ignored; with several companies, `companyId` picks one. */
export function rowsToMap(rows: readonly SystemCategoryRow[], companyId?: string | null): SystemCategoryMap {
  const map: SystemCategoryMap = {}
  for (const r of rows) {
    if (!KNOWN.has(r.role)) continue
    if (companyId && r.company_id !== companyId) continue
    map[r.role as SystemRole] = {
      pl_category: r.pl_category ?? null,
      pl_subcategory: r.pl_subcategory ?? null,
      department: r.department ?? null,
      dept_subcategory: r.dept_subcategory ?? null,
      expense_description: r.expense_description ?? null,
    }
  }
  return map
}

/**
 * Every system category the user can see, as a map.
 *
 * Throws on a read error: an error read as "nothing is set" would only make
 * every posting refuse with the wrong reason; read as "something is set" it
 * would be worse.
 */
export async function fetchSystemCategories(
  client: any, companyId?: string | null,
): Promise<SystemCategoryMap> {
  let q = client.from('system_categories')
    .select('id, company_id, role, pl_category, pl_subcategory, department, dept_subcategory, expense_description')
  if (companyId) q = q.eq('company_id', companyId)
  const { data, error } = await q
  if (error) throw new Error(`Sistemske kategorije nisu učitane: ${error.message}`)
  return rowsToMap((data || []) as SystemCategoryRow[], companyId)
}

/**
 * Save one role. Only the role's own fields are written; the rest are
 * cleared, so a row never carries a value nobody can see in the settings tab.
 */
export async function saveSystemCategory(
  client: any, companyId: string, role: SystemRole, c: Partial<Classification>,
): Promise<void> {
  const fields = roleDef(role).fields
  const row: SystemCategoryRow = { company_id: companyId, role, ...EMPTY_CLASSIFICATION }
  for (const f of fields) row[f] = filled(c[f]) ? (c[f] as string).trim() : null
  const { error } = await client.from('system_categories')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'company_id,role' })
  if (error) throw new Error(`Sistemska kategorija „${roleDef(role).label}“ nije sačuvana: ${error.message}`)
}
