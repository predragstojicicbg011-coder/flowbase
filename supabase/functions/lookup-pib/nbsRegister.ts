// ─── The NBS account register, read ─────────────────────────────────────────
//
// Jedinstveni registar računa (NBS): the public search of residents' current
// accounts. A plain GET by registration number (matični broj) answers with an
// HTML table, one row per account, the company repeated on each row: name,
// PIB, address, place, municipality, activity, bank, account, status, whether
// it can be blocked, the date it was opened. No login, no token, no AI.
//
// Pure functions, no Deno APIs, so the app's tests can read them too.

export const REGISTER_ORIGIN = 'https://webappcenter.nbs.rs'
const REGISTER_PATH = '/PnWebApp/CompanyAccount/CompanyAccountResident'
export const PAGE_SIZE = 50

/** Dinar current accounts (TypeID 1) of one registration number, one page. */
export function registerSearchUrl(mb: string, page = 1): string {
  const q = new URLSearchParams({
    isSearchExecuted: 'true', CompanyNationalCode: mb, TypeID: '1', OrderBy: '',
    'Pagging.CurrentPage': String(page), 'Pagging.PageSize': String(PAGE_SIZE),
  })
  return `${REGISTER_ORIGIN}${REGISTER_PATH}?${q.toString()}`
}

export interface RegisterRow {
  name: string
  mb: string
  pib: string
  address: string
  city: string
  municipality: string
  activity: string
  bankName: string
  account: string
  /** As the register writes it: "Укључен" is open. */
  status: string
  blockable: string
  /** ISO date, or '' when unreadable. */
  opened: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A cell's text: tags out, entities decoded, whitespace folded. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** "29.7.2003." → "2003-07-29". */
function isoDate(s: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(s.trim())
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''
}

const FIELD: Record<string, keyof RegisterRow> = {
  'Назив корисника рачуна': 'name',
  'Матични број': 'mb',
  'Порески број': 'pib',
  'Адреса': 'address',
  'Место': 'city',
  'Општина': 'municipality',
  'Делатност': 'activity',
  'Банка': 'bankName',
  'Рачун': 'account',
  'Статус': 'status',
  'Подлеже/не подлеже блокади': 'blockable',
  'Датум отварања': 'opened',
}

/** The account rows of one page and the register's total, by each cell's data-title. */
export function parseRegisterPage(html: string): { rows: RegisterRow[]; total: number } {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? ''
  const rows: RegisterRow[] = []
  for (const tr of body.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? []) {
    const row: RegisterRow = {
      name: '', mb: '', pib: '', address: '', city: '', municipality: '', activity: '',
      bankName: '', account: '', status: '', blockable: '', opened: '',
    }
    for (const td of tr.matchAll(/<td\b[^>]*data-title="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)) {
      const key = FIELD[text(td[1])]
      if (key) row[key] = text(td[2])
    }
    row.opened = isoDate(row.opened)
    if (row.account) rows.push(row)
  }
  const total = Number(/Укупан број резултата:\s*(\d+)/.exec(text(html))?.[1] ?? rows.length)
  return { rows, total }
}

export interface RegisterCompany {
  name: string
  mb: string
  pib: string
  address: string
  city: string
  municipality: string
  activity: string
  /** Open accounts only, newest first. */
  accounts: { account: string; bankName: string; opened: string }[]
}

const isOpen = (r: RegisterRow) => /укључен/i.test(r.status)

/**
 * The company the rows describe. Its name and address as on the newest open
 * account: older accounts keep the name the company had when they were opened.
 */
export function companyFromRows(rows: RegisterRow[]): RegisterCompany | null {
  if (rows.length === 0) return null
  const open = rows.filter(isOpen).sort((a, b) => b.opened.localeCompare(a.opened))
  const head = open[0] ?? rows.slice().sort((a, b) => b.opened.localeCompare(a.opened))[0]
  return {
    name: head.name, mb: head.mb, pib: head.pib, address: head.address, city: head.city,
    municipality: head.municipality, activity: head.activity,
    accounts: open.map(r => ({ account: r.account, bankName: r.bankName, opened: r.opened })),
  }
}
