// ─── The sentences of the preliminary payroll ──────────────────────────────
//
// Every sentence a test pins is written here once, so the page and the test
// cannot drift apart. Serbian, Latin script, the glossary's terms
// (docs/recnik.md): "preliminarni obračun", "pretpostavljeni sati",
// "evidencija radnog vremena".

import { countOf, plural } from '../../utils/plural'

/** Preliminary: on assumed hours or an earlier day's rate. Regular: everything real. */
export type RunKind = 'preliminary' | 'regular'

/** The word every preliminary figure carries. */
export const PRELIMINARY = 'Preliminarno'

/** A kind as the sentences say it of a calculation. */
export const kindWord = (k: RunKind): string => (k === 'preliminary' ? 'preliminaran' : 'redovan')

/** A sentence that ends on a date written `20.11.2026.` takes no second period. */
const ending = (s: string): string => (s.endsWith('.') ? s : `${s}.`)

// ─── The template ──────────────────────────────────────────────────────────

export const TEMPLATE_NEGATIVE = 'Pretpostavljeni sati ne mogu biti negativni.'

export const TEMPLATE_OFF_FUND = (total: number, fund: number): string =>
  `Pretpostavljeni sati iznose ${total}, a fond sati ovog meseca je ${fund}, pa se ne primenjuju. `
  + 'Sačuvajte ih ponovo na kartici Evidencija radnog vremena u Kadrovskoj evidenciji.'

export const TEMPLATE_PANEL_TITLE = 'Pretpostavljeni sati za ovaj mesec'

export const templateHint = (fund: number): string =>
  `Fond sati ovog meseca je ${fund}. Ovo su sati zaposlenog koji je radio ceo mesec; `
  + 'svako bez evidencije radnog vremena dobija svoj deo, po radnim danima u obračunu.'

export const SAVE_TEMPLATE = 'Sačuvaj pretpostavljene sate'

export const REMOVE_TEMPLATE = 'Ukloni'

export const templateTotalLine = (total: number, fund: number): string => `Ukupno ${total} od ${fund}`

export const TEMPLATE_NOT_SAVED = 'Pretpostavljeni sati nisu sačuvani. '
  + 'Čuva ih samo administrator ili vlasnik, i samo za tekući mesec.'

export const TEMPLATE_NOT_REMOVED = 'Pretpostavljeni sati nisu uklonjeni. '
  + 'Uklanja ih samo administrator ili vlasnik, i samo za tekući mesec.'

export const templateNotRead = (why: string): string => `Pretpostavljeni sati nisu učitani: ${why}`

export const TEMPLATE_READ_ONLY = 'Ove sate čuva samo administrator ili vlasnik.'

export const TEMPLATE_UNSAVED = 'Za ovaj mesec nisu sačuvani pretpostavljeni sati, pa zaposleni '
  + 'bez evidencije radnog vremena nisu u obračunu.'

/** Said under the template only when it is saved and adds up to the fund. */
export const onTemplateCount = (n: number): string =>
  `${countOf(n, 'zaposleni', 'zaposlena', 'zaposlenih')} ${plural(n, 'nema', 'nemaju', 'nema')} `
  + `evidenciju radnog vremena i ${plural(n, 'obračunava se', 'obračunavaju se', 'obračunava se')} `
  + 'na ovim satima.'

export const FILL_IS_DIFFERENT = 'Dugme „Upiši pun mesec“ je drugi alat: ono upisuje prave '
  + 'evidencije radnog vremena, a pretpostavljeni sati se nikad ne upisuju kao evidencija.'

export const NO_DAY_ON_PAYROLL = 'Nema nijedan radni dan u obračunu ovog meseca, '
  + 'pa se za tu osobu sati ne pretpostavljaju.'

// ─── The Payroll page ──────────────────────────────────────────────────────

/** The notice above a preliminary month: each part only when it is true. */
export function noticeFor(a: {
  onTemplate: number
  people: number
  noDays?: number
  /** The rate's day and the 20th's, both written `dd.mm.gggg.`, when the rate is not yet it. */
  rate?: { day: string; twentieth: string } | null
}): string {
  const parts: string[] = []
  if (a.onTemplate > 0) {
    parts.push(`Na pretpostavljenim satima obračunato je ${a.onTemplate} od ${a.people} zaposlenih.`)
  }
  const noDays = a.noDays ?? 0
  if (noDays > 0) {
    parts.push(`${countOf(noDays, 'zaposleni', 'zaposlena', 'zaposlenih')} bez ijednog radnog dana `
      + `u obračunu ovog meseca ${plural(noDays, 'nema', 'nemaju', 'nema')} evidenciju radnog vremena.`)
  }
  if (a.rate) {
    parts.push(`Iznosi u evrima preračunati su po kursu od ${a.rate.day}, `
      + `a ne po kursu za ${ending(a.rate.twentieth)}`)
  }
  // After the colon the first part goes on in lower case, as Serbian writes it.
  const [first = '', ...rest] = parts
  return ['Preliminarno:', first.charAt(0).toLowerCase() + first.slice(1), ...rest].join(' ').trim()
}

export const POSTING_NOT_OFFERED = 'Preliminarni obračun se ne knjiži. Postaje redovan kada svi '
  + 'zaposleni imaju evidenciju radnog vremena, a iznosi u evrima su preračunati po kursu za 20.'

export const PRELIMINARY_REFUSED = 'Ovaj obračun je preliminaran, pa se ne knjiži. Ništa nije upisano.'

export const RUN_NOT_FOUND = 'Sačuvani obračun nije pronađen, pa ništa nije proknjiženo. '
  + 'Prvo kliknite „Ponovo obračunaj“.'

export const RUN_NOT_REMOVED = 'Sačuvani obračun nije uklonjen. '
  + 'Možda je u međuvremenu proknjižen; osvežite stranu.'

export const RUN_HAS_POSTING = 'Ovaj obračun ima knjiženje u glavnoj knjizi, pa se ne uklanja. '
  + 'Prvo poništite knjiženje.'

export const KEPT_KIND_DIFFERS = (kept: RunKind, now: RunKind): string =>
  `Sačuvani obračun je ${kindWord(kept)}, a obračun ovog meseca je sada ${kindWord(now)}. `
  + 'Ponovo obračunajte pre knjiženja.'

export const KEPT_RUN_EMPTY = 'Sačuvan je raniji obračun, ali u ovom obračunu sada nema nikoga. '
  + '„Ponovo obračunaj“ uklanja ono što je sačuvano.'

/** The first line of the copied table of a preliminary month. */
export const copyHeading = (month: string): string =>
  `Preliminarni obračun za ${month}, a ne obračun zarade meseca`

export const PAYSLIP_TITLE = 'Obračun zarade i naknade zarade'

export const PAYSLIP_TITLE_PRELIMINARY = 'Preliminarni obračun zarade i naknade zarade'

// ─── Against last month's regular payroll ──────────────────────────────────

export const COMPARISON_TITLE = 'Poređenje sa redovnim obračunom prošlog meseca'

export const ONE_COMPANY = 'Izaberite jednu firmu da biste poredili sa prošlim mesecom.'

export const NO_LAST_REGULAR = 'Za prošli mesec ove firme nije sačuvan redovan obračun, '
  + 'pa nema sa čim da se poredi.'

export const NOT_COMPARED = (n: number): string =>
  `${countOf(n, 'zaposleni', 'zaposlena', 'zaposlenih')} ${plural(n, 'nije', 'nisu', 'nije')} `
  + 'u obračunu ovog meseca, pa se ne poredi sa prošlim mesecom.'

export const COMPARISON_READING = 'Učitavanje prošlog meseca…'

export const PEOPLE_JOINED = 'Novi ovog meseca'

export const PEOPLE_LEFT = 'Više nisu u obračunu'

export const PEOPLE_CHANGED = 'Promenjen ukupan trošak'

export const SHOW_PEOPLE = 'Prikaži ko pravi razliku'

export const HIDE_PEOPLE = 'Sakrij ko pravi razliku'
