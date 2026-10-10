// ── Who this copy of the app belongs to ───────────────────────────────────
//
// FlowBase is the template every client app is made from, and every client
// keeps receiving its updates by `git merge`. So no source file names a
// client: the name of the app and of the company come from environment
// variables (.env locally, Project Settings → Environment Variables on
// Vercel), read here and nowhere else. CRA bakes REACT_APP_* into the bundle
// at build time; a change needs a new build.
//
//   REACT_APP_APP_NAME       name of the app            (default "FlowBase")
//   REACT_APP_COMPANY_NAME   legal name of the company  (default "Demo d.o.o.")
//   REACT_APP_COMPANY_SHORT  short name, for headings   (default: the legal
//                            name without "d.o.o." / "doo")
//   REACT_APP_TAGLINE        optional line on the login page

export interface Brand {
  /** Name of the app, e.g. "AlfaFlow". */
  appName: string
  /** Legal name of the company, e.g. "Alfa Gradnja doo". */
  companyName: string
  /** Short name for headings and badges, e.g. "Alfa Gradnja". */
  companyShort: string
  /** Line under the login headline. */
  tagline: string
  /** The app name split for the two-colour logo: "AlfaFlow" → ["Alfa", "Flow"]. */
  logo: [lead: string, accent: string]
  /** Prefix for browser storage keys: "AlfaFlow" → "alfaflow". */
  storagePrefix: string
}

export const DEFAULT_APP_NAME = 'FlowBase'
export const DEFAULT_COMPANY_NAME = 'Demo d.o.o.'

type Env = Record<string, string | undefined>

function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

/** "Alfa Gradnja doo" → "Alfa Gradnja"; "Demo d.o.o." → "Demo". */
export function shortCompanyName(legal: string): string {
  const short = legal.replace(/[\s,]+(d\.?\s?o\.?\s?o\.?|a\.?d\.?)\s*$/i, '').trim()
  return short || legal
}

/** Splits the last capitalised word off: "AlfaFlow" → ["Alfa", "Flow"]. */
export function logoParts(appName: string): [string, string] {
  const m = /^(.+?)([A-Z][a-z]+)$/.exec(appName)
  return m ? [m[1], m[2]] : [appName, '']
}

export function storagePrefixFor(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'flowbase'
}

export function readBrand(env: Env): Brand {
  const appName = clean(env.REACT_APP_APP_NAME) || DEFAULT_APP_NAME
  const companyName = clean(env.REACT_APP_COMPANY_NAME) || DEFAULT_COMPANY_NAME
  const companyShort = clean(env.REACT_APP_COMPANY_SHORT) || shortCompanyName(companyName)
  const tagline = clean(env.REACT_APP_TAGLINE)
    || `Novac, fakture, krediti i zarade za ${companyShort} — na jednom mestu.`
  return {
    appName,
    companyName,
    companyShort,
    tagline,
    logo: logoParts(appName),
    storagePrefix: storagePrefixFor(appName),
  }
}

// CRA replaces each `process.env.REACT_APP_X` expression at build time, so
// the variables are named one by one rather than passing process.env along.
export const brand: Brand = readBrand({
  REACT_APP_APP_NAME: process.env.REACT_APP_APP_NAME,
  REACT_APP_COMPANY_NAME: process.env.REACT_APP_COMPANY_NAME,
  REACT_APP_COMPANY_SHORT: process.env.REACT_APP_COMPANY_SHORT,
  REACT_APP_TAGLINE: process.env.REACT_APP_TAGLINE,
})

export default brand
