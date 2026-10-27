// ─── iosStatement ───────────────────────────────────────────────────────────
//
// IOS — izvod otvorenih stavki: what is still open with a partner on a day,
// sent to them to confirm or dispute (Zakon o računovodstvu). Built from the
// same data as the partner card (loadPartnerCard), so its total IS the card's
// balance on that day: a document's remainder is its amount with the notes
// linked to it, less the payments and the advances used, all dated by then.
//
// Open items are bills, debit notes, and credit notes not linked to a bill (a
// linked credit note is folded into its bill; a debit note is its own item); our invoices to a customer count
// against us. Proformas, advance invoices and direct payments are not open
// items: advances are shown apart, under the total (the client's decision).
//
// Sign: positive is what we owe the partner, as on the card.

import { fmtMoney, fmtNum } from '../utils/formatters'
import type { CardCoverage, CardDirect, CardDocument, CardPayment, CardUsage } from './partnerCard'
import type { PrintParty } from './partnerCardPrint'

export interface OpenItem {
  documentId: string
  number: string | null
  date: string | null
  due: string | null
  /** The document with its linked notes, as of the day. */
  amount: number
  open: number
}

const r2 = (n: number) => Math.round(n * 100) / 100
const num = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? v : 0 }

export function openItemsAsOf(
  input: { documents: CardDocument[]; payments: CardPayment[]; usage: CardUsage[]; coverage?: CardCoverage[]; direct?: CardDirect[] },
  asOf: string,
): { items: OpenItem[]; total: number } {
  const by = (d: string | null | undefined) => (d || '') <= asOf
  const byId = new Map(input.documents.map(d => [d.id, d]))
  // A credit note linked to a bill belongs to that bill's line; a debit note is owed by itself.
  const lineOf = (d: CardDocument) => (d.document_type === 'credit_note' && d.adjusts_invoice_id && byId.has(d.adjusts_invoice_id) ? d.adjusts_invoice_id : d.id)
  const lines = new Map<string, { head: CardDocument; amount: number; settled: number }>()

  for (const d of input.documents) {
    const kind = d.document_type || 'invoice'
    if (kind === 'proforma' || kind === 'advance_invoice' || !by(d.invoice_date)) continue
    const id = lineOf(d)
    const head = byId.get(id) as CardDocument
    const sign = head.type === 'revenue' ? -1 : 1
    const line = lines.get(id) || { head, amount: 0, settled: 0 }
    line.amount = r2(line.amount + sign * num(d.amount_rsd))
    if (head.type === 'revenue' && d.id === head.id) line.settled = r2(line.settled - num(d.advance_deducted_rsd))
    lines.set(id, line)
  }
  for (const p of input.payments) {
    const d = byId.get(p.invoice_id)
    if (!d || !by(p.date)) continue
    const line = lines.get(lineOf(d))
    if (!line) continue
    line.settled = r2(line.settled + (line.head.type === 'revenue' ? -1 : 1) * num(p.amount_rsd))
  }
  for (const u of input.usage) {
    const fin = byId.get(u.final_invoice_id)
    const line = fin && by(fin.invoice_date) ? lines.get(lineOf(fin)) : undefined
    if (line) line.settled = r2(line.settled + num(u.amount_rsd))
  }

  const items: OpenItem[] = []
  lines.forEach(({ head, amount, settled }) => {
    const open = r2(amount - settled)
    if (Math.abs(open) < 0.005) return
    items.push({ documentId: head.id, number: head.invoice_number, date: head.invoice_date, due: head.due_date ?? null, amount, open })
  })
  items.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.number || '').localeCompare(b.number || ''))
  return { items, total: r2(items.reduce((s, i) => s + i.open, 0)) }
}

/** „IOS-100000004-20261031“: the partner's tax id and the day. */
export function iosNumber(partnerTaxId: string | null | undefined, asOf: string): string {
  return `IOS-${partnerTaxId || 'bez-PIB'}-${asOf.replace(/-/g, '')}`
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const dateSr = (d: string | null | undefined) => (d ? d.split('-').reverse().join('.') : '—')

export interface IosParty extends PrintParty { mb?: string | null; registration_number?: string | null }

function party(title: string, p: IosParty): string {
  const pib = p.pib || p.tax_id
  const mb = p.mb || p.registration_number
  const place = [p.address, p.city].filter(Boolean).join(', ')
  return `<div class="party"><div class="label">${esc(title)}</div><div class="name">${esc(p.full_legal_name || p.name || '—')}</div>`
    + (place ? `<div>${esc(place)}</div>` : '')
    + `<div>${pib ? `PIB ${esc(pib)}` : ''}${pib && mb ? ' · ' : ''}${mb ? `MB ${esc(mb)}` : ''}</div></div>`
}

export function iosPrintHtml(p: {
  company: IosParty
  partner: IosParty
  asOf: string
  statement: { items: OpenItem[]; total: number }
  advancesOpen: number
  number: string
  generatedOn: string
  /** The currency the statement is in; dinars when not given. */
  currency?: string
}): string {
  const currency = p.currency || 'RSD'
  const day = dateSr(p.asOf)
  const { items, total } = p.statement
  const rows = items.length
    ? items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.number || 'bez broja')}</td><td>${dateSr(i.date)}</td><td>${dateSr(i.due)}</td>`
      + `<td class="n">${esc(fmtNum(i.amount))}</td><td class="n">${esc(fmtNum(i.open))}</td></tr>`).join('\n')
    : '<tr><td colspan="6">Nema otvorenih stavki na ovaj dan.</td></tr>'
  const verdict = total > 0.005 ? `Stanje Vašeg potraživanja prema nama na dan ${day}`
    : total < -0.005 ? `Stanje našeg potraživanja prema Vama na dan ${day}`
    : `Na dan ${day} nema otvorenih obaveza ni potraživanja`
  const place = p.company.city || ''
  return `<!doctype html>
<html lang="sr"><head><meta charset="utf-8">
<title>IOS — ${esc(p.partner.full_legal_name || p.partner.name || '')} — ${day}</title>
<style>
  @page { size: A4; margin: 14mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
  h1 { font-size: 15pt; text-align: center; margin: 4mm 0 1mm; letter-spacing: .04em; }
  .sub { text-align: center; margin-bottom: 5mm; }
  .head { display: flex; justify-content: space-between; color: #444; font-size: 9.5pt; }
  .parties { display: flex; gap: 10mm; margin: 4mm 0; }
  .party { flex: 1; border: 1px solid #bbb; border-radius: 2mm; padding: 3mm; }
  .party .label { font-size: 8.5pt; color: #666; text-transform: uppercase; letter-spacing: .03em; }
  .party .name { font-weight: 600; margin: 1mm 0; }
  p { line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  th, td { padding: 1.6mm 2mm; border: 1px solid #ccc; text-align: left; }
  th { background: #f2f2f2; font-size: 9pt; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .total { display: flex; justify-content: space-between; font-weight: 700; font-size: 11.5pt; margin-top: 4mm; padding: 3mm; border: 1.5px solid #111; }
  .adv { margin-top: 2mm; font-size: 9.5pt; color: #444; }
  .answer { margin-top: 7mm; border: 1px solid #888; padding: 4mm; page-break-inside: avoid; }
  .answer h2 { font-size: 11pt; margin: 0 0 3mm; }
  .box { display: inline-block; width: 4mm; height: 4mm; border: 1px solid #111; margin-right: 2mm; vertical-align: -0.6mm; }
  .line { display: inline-block; border-bottom: 1px solid #111; min-width: 45mm; }
  .signs { display: flex; gap: 12mm; margin-top: 9mm; page-break-inside: avoid; }
  .sign { flex: 1; }
  .sign .who { font-weight: 600; margin-bottom: 8mm; }
  .sign .row { display: flex; justify-content: space-between; margin-top: 8mm; }
  .sign .slot { border-top: 1px solid #111; padding-top: 1mm; font-size: 9pt; width: 45%; text-align: center; }
</style></head>
<body>
<div class="head"><span>Broj: ${esc(p.number)}</span><span>${esc(place ? `${place}, ` : '')}${dateSr(p.generatedOn)}</span></div>
<h1>IZVOD OTVORENIH STAVKI</h1>
<div class="sub">na dan ${day}</div>
<div class="parties">${party('Pošiljalac', p.company)}${party('Primalac', p.partner)}</div>
<p>U skladu sa Zakonom o računovodstvu, dostavljamo Vam izvod otvorenih stavki sa stanjem na dan ${day}.
Molimo Vas da stanje uporedite sa svojom evidencijom i u roku od 8 dana od prijema vratite jedan potpisan primerak.
Ukoliko u tom roku ne dobijemo odgovor, smatraćemo da je stanje usaglašeno.</p>
<table>
<thead><tr><th>R. br.</th><th>Broj dokumenta</th><th>Datum</th><th>Dospeće</th><th class="n">Iznos dokumenta</th><th class="n">Otvoreno</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="total"><span>${esc(verdict)}</span><span>${esc(fmtMoney(Math.abs(total), currency))}</span></div>
${p.advancesOpen > 0.005 ? `<div class="adv">Dati avansi (ne ulaze u stanje): ${esc(fmtMoney(p.advancesOpen, currency))}</div>` : ''}
<div class="answer">
  <h2>Odgovor partnera</h2>
  <div><span class="box"></span>Potvrđujemo da je stanje usaglašeno.</div>
  <div style="margin-top:4mm"><span class="box"></span>Osporavamo stanje u iznosu od <span class="line">&nbsp;</span> ${esc(currency)}, iz razloga:</div>
  <div style="margin-top:6mm; border-bottom:1px solid #111">&nbsp;</div>
  <div style="margin-top:6mm; border-bottom:1px solid #111">&nbsp;</div>
</div>
<div class="signs">
  <div class="sign"><div class="who">Za pošiljaoca</div><div class="row"><div class="slot">Mesto i datum</div><div class="slot">M.P.</div></div><div class="row"><div class="slot" style="width:100%">Potpis odgovornog lica</div></div></div>
  <div class="sign"><div class="who">Za primaoca</div><div class="row"><div class="slot">Mesto i datum</div><div class="slot">M.P.</div></div><div class="row"><div class="slot" style="width:100%">Potpis odgovornog lica</div></div></div>
</div>
<script>window.addEventListener('load', function () { window.focus(); window.print(); });</script>
</body></html>`
}
