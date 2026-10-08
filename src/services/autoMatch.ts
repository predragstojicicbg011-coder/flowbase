// ─── Auto-matching engine ───────────────────────────────────────────────────
//
// Cista logika, bez UI-ja i bez pristupa bazi — da se moze testirati.
//
// Nacelo: engine NIKAD ne knjizi sam. On samo predlaze parove sa ocjenom
// pouzdanosti i obrazlozenjem. Potvrdjuje covjek. Za finansijske podatke
// automatsko knjizenje na osnovu heuristike nije prihvatljivo.

export type Confidence = 'high' | 'medium' | 'low'

export interface PassthroughRow {
  id: string
  company_id: string
  partner_id: string | null
  partner_name?: string | null
  transaction_date: string
  direction: 'in' | 'out'
  amount: number
  /** Book figure in dinars — what the engine compares. */
  amount_rsd: number
  amount_eur?: number | null
  currency: string
  note?: string | null
  reference_number?: string | null
}

export interface PairProposal {
  inRow: PassthroughRow
  outRow: PassthroughRow
  score: number
  confidence: Confidence
  reasons: string[]
  /** The gap between the two legs, in RSD (the book currency). */
  amountDiffRsd: number
  dayGap: number
}

// ── Pomocne ────────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = [
  'd.o.o.', 'doo', 'd.o.o', 'llc', 'l.l.c', 'ltd', 'limited', 'inc', 'inc.',
  'a.d.', 'ad', 'gmbh', 'b.v.', 'bv', 's.r.o', 'plc', 'corp', 'corporation',
  'l.l.c-fz', 'fz', 'pr', 'sp',
]

/** Normalizuje ime partnera da bi "Primer d.o.o. Beograd" i
 *  "PRIMER DOO  BEOGRAD" bili isti string. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return ''
  let n = name.toLowerCase()
  // Tacke i apostrofi se BRISU, ne zamjenjuju razmakom — inace se "d.o.o."
  // raspadne na "d o o" i "l.l.c" na "l l c", pa se pravni oblik vise ne
  // prepoznaje i dvije varijante istog imena ne daju isti rezultat.
  n = n.replace(/['.]/g, '')
  n = n.replace(/[,\-_/\\()[\]"]/g, ' ')
  n = n.replace(/\s+/g, ' ').trim()
  const words = n.split(' ').filter(w => w && !LEGAL_SUFFIXES.includes(w))
  return words.join(' ')
}

export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime())
  return Math.round(ms / 86400000)
}

function confidenceOf(score: number): Confidence {
  if (score >= 85) return 'high'
  if (score >= 60) return 'medium'
  return 'low'
}

// ── Pravila ────────────────────────────────────────────────────────────────
//
// Granicne vrijednosti su namjerno konzervativne. Bolje je predloziti manje
// parova nego predloziti pogresan — pogresno uparen pass-through krivi
// cash flow, a niko to kasnije ne provjerava.

export const MATCH_LIMITS = {
  maxDayGap: 45,        // preko ovoga se ne predlaze uopste
  maxRelAmountDiff: 0.03, // 3% — pokriva bankarske naknade na transferu
  minScore: 40,
}

/**
 * Ocjenjuje jedan mogucan par IN/OUT. Vraca null ako par ne prolazi
 * osnovne uslove (tada se uopste ne predlaze).
 */
export function scorePair(inRow: PassthroughRow, outRow: PassthroughRow): PairProposal | null {
  if (inRow.direction !== 'in' || outRow.direction !== 'out') return null
  if (inRow.company_id !== outRow.company_id) return null
  if (inRow.id === outRow.id) return null

  const reasons: string[] = []
  let score = 0

  // ── Iznos ──
  // Uvijek u RSD (knjigovodstvena valuta), nezavisno od valute prikaza — par
  // ne smije da se promijeni kad korisnik prebaci prikaz na EUR.
  const a = Math.abs(inRow.amount_rsd || 0)
  const b = Math.abs(outRow.amount_rsd || 0)
  const diff = Math.abs(a - b)
  const base = Math.max(a, b)
  if (base === 0) return null
  const rel = diff / base

  if (diff <= 0.01) { score += 50; reasons.push('isti iznos') }
  else if (rel <= 0.01) { score += 38; reasons.push(`iznos se razlikuje ${(rel * 100).toFixed(1).replace('.', ',')}%`) }
  else if (rel <= MATCH_LIMITS.maxRelAmountDiff) { score += 22; reasons.push(`iznos se razlikuje ${(rel * 100).toFixed(1).replace('.', ',')}% (moguća provizija)`) }
  else return null

  // ── Partner ──
  if (inRow.partner_id && outRow.partner_id) {
    if (inRow.partner_id === outRow.partner_id) { score += 30; reasons.push('isti partner') }
    else return null   // razliciti poznati partneri — sigurno nije par
  } else {
    const n1 = normalizeName(inRow.partner_name)
    const n2 = normalizeName(outRow.partner_name)
    if (n1 && n2 && n1 === n2) { score += 26; reasons.push('isti naziv partnera') }
    else if (n1 && n2 && (n1.includes(n2) || n2.includes(n1))) { score += 16; reasons.push('naziv partnera se delimično poklapa') }
    else reasons.push('partner nije potvrđen')
  }

  // ── Datum ──
  const gap = daysBetween(inRow.transaction_date, outRow.transaction_date)
  if (gap > MATCH_LIMITS.maxDayGap) return null
  if (gap <= 2) { score += 20; reasons.push(gap === 0 ? 'isti dan' : `razmak ${gap} d`) }
  else if (gap <= 7) { score += 14; reasons.push(`razmak ${gap} d`) }
  else if (gap <= 30) { score += 7; reasons.push(`razmak ${gap} d`) }
  else { reasons.push(`razmak ${gap} d — veliki`) }

  // ── Referenca ──
  const r1 = (inRow.reference_number || '').trim()
  const r2 = (outRow.reference_number || '').trim()
  if (r1 && r2 && r1 === r2) { score += 10; reasons.push('isti poziv na broj') }

  if (score < MATCH_LIMITS.minScore) return null

  return {
    inRow, outRow, score,
    confidence: confidenceOf(score),
    reasons,
    amountDiffRsd: Math.round(diff * 100) / 100,
    dayGap: gap,
  }
}

/**
 * Gradi prijedloge parova iz liste nesparenih stavki.
 *
 * Dodjela je pohlepna (greedy) i 1:1 — svaka stavka moze uci u najvise jedan
 * prijedlog. Sortira se po ocjeni opadajuce, pa se uzimaju parovi cije obje
 * strane jos nisu iskoristene. To sprjecava da jedna uplata "pokrije" vise
 * isplata i obrnuto.
 */
export function proposePairs(rows: PassthroughRow[]): PairProposal[] {
  const ins = rows.filter(r => r.direction === 'in')
  const outs = rows.filter(r => r.direction === 'out')

  const all: PairProposal[] = []
  for (const i of ins) {
    for (const o of outs) {
      const p = scorePair(i, o)
      if (p) all.push(p)
    }
  }

  // Jaci prijedlog prvi; kod izjednacenja prednost ima manji vremenski razmak.
  all.sort((x, y) => y.score - x.score || x.dayGap - y.dayGap)

  const used = new Set<string>()
  const chosen: PairProposal[] = []
  for (const p of all) {
    if (used.has(p.inRow.id) || used.has(p.outRow.id)) continue
    used.add(p.inRow.id)
    used.add(p.outRow.id)
    chosen.push(p)
  }
  return chosen
}

export function summarize(proposals: PairProposal[]) {
  return {
    total: proposals.length,
    high: proposals.filter(p => p.confidence === 'high').length,
    medium: proposals.filter(p => p.confidence === 'medium').length,
    low: proposals.filter(p => p.confidence === 'low').length,
  }
}
