// ─── partnerCardPrint ───────────────────────────────────────────────────────
//
// The partner's card as a page to print, or to save as PDF from the print
// dialog (the client's choice: no PDF library, the browser's own fonts carry
// č ć š đ ž). A whole HTML document; the dialog writes it into a hidden frame,
// which opens the print dialog once it has loaded.
//
// Everything that comes from the database is escaped: a partner's name or a
// bank statement's note is text, never markup.

import { fmtMoney, fmtNum } from '../utils/formatters'
import type { PartnerCard } from './partnerCard'

export interface PrintParty { name?: string | null; full_legal_name?: string | null; tax_id?: string | null; pib?: string | null; address?: string | null; city?: string | null }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const dateSr = (d: string | null | undefined) => (d ? d.split('-').reverse().join('.') : '—')
const money = (n: number) => esc(fmtMoney(n, 'RSD'))
const plain = (n: number) => (n ? esc(fmtNum(n)) : '')

function party(title: string, p: PrintParty): string {
  const name = p.full_legal_name || p.name || '—'
  const pib = p.pib || p.tax_id
  const place = [p.address, p.city].filter(Boolean).join(', ')
  return `<div class="party"><div class="label">${esc(title)}</div><div class="name">${esc(name)}</div>`
    + (pib ? `<div>PIB ${esc(pib)}</div>` : '')
    + (place ? `<div>${esc(place)}</div>` : '')
    + '</div>'
}

export function partnerCardPrintHtml(p: {
  company: PrintParty
  partner: PrintParty
  period: { from: string | null; to: string | null }
  card: PartnerCard
  generatedOn: string
}): string {
  const { card, period } = p
  const periodText = `${period.from ? dateSr(period.from) : 'od početka knjiga'} – ${period.to ? dateSr(period.to) : 'danas'}`
  const rows = [
    period.from
      ? `<tr class="muted"><td>${dateSr(period.from)}</td><td>Početni saldo</td><td class="n"></td><td class="n"></td><td class="n">${plain(card.opening) || '0,00'}</td></tr>`
      : '',
    ...card.rows.map(r => `<tr><td>${dateSr(r.date)}</td><td>${esc(r.label)}${r.refers && !r.label.endsWith(r.refers) ? ` <span class="ref">· ${esc(r.refers)}</span>` : ''}</td>`
      + `<td class="n">${plain(r.debit)}</td><td class="n">${plain(r.credit)}</td><td class="n">${esc(fmtNum(r.balance))}</td></tr>`),
    card.rows.length === 0 ? '<tr><td colspan="5" class="muted">Nema promena u ovom periodu.</td></tr>' : '',
  ].join('\n')

  const advances = card.advances.invoices.length || card.advances.proformaPayments.length
    ? `<h3>Avansi kod dobavljača (ne ulaze u saldo)</h3><table class="list">`
      + card.advances.proformaPayments.map(a => `<tr><td>${dateSr(a.date)}</td><td>Isplata po predračunu ${esc(a.invoice_number || 'bez broja')} — ${esc(a.bank || 'banka')}</td><td class="n">${money(a.amount)}</td></tr>`).join('')
      + card.advances.invoices.map(a => `<tr><td>${dateSr(a.date)}</td><td>Avansni račun ${esc(a.invoice_number || 'bez broja')}${a.priorPeriod ? ' (iz ranijeg perioda)' : ''} · ${money(a.amount)} · iskorišćeno ${money(a.used)}</td><td class="n">otvoreno ${money(a.open)}</td></tr>`).join('')
      + '</table>'
      + (card.advances.paidWithoutAdvance > 0.005 ? `<p class="warn">Plaćeno po predračunima bez avansnog računa: ${money(card.advances.paidWithoutAdvance)}</p>` : '')
    : ''

  const direct = card.direct.length
    ? `<h3>Direktna plaćanja bez računa (ne menjaju saldo)</h3><table class="list">`
      + card.direct.map(t => `<tr><td>${dateSr(t.date)}</td><td>${t.direction === 'in' ? 'Uplata' : 'Isplata'} — ${esc(t.bank || 'banka')}${t.note ? ` · „${esc(t.note)}“` : ''}</td><td class="n">${money(t.amount)}</td></tr>`).join('')
      + '</table>'
    : ''

  const partnerName = p.partner.full_legal_name || p.partner.name || ''
  return `<!doctype html>
<html lang="sr"><head><meta charset="utf-8">
<title>Kartica partnera — ${esc(partnerName)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h3 { font-size: 11pt; margin: 6mm 0 2mm; }
  .meta { color: #444; margin-bottom: 5mm; }
  .parties { display: flex; gap: 10mm; margin-bottom: 5mm; }
  .party { flex: 1; border: 1px solid #ccc; border-radius: 2mm; padding: 3mm; }
  .party .label { font-size: 8.5pt; color: #666; text-transform: uppercase; letter-spacing: .03em; }
  .party .name { font-weight: 600; margin: 1mm 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1.6mm 2mm; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { font-size: 9pt; color: #444; border-bottom: 1.5px solid #888; }
  .n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .muted { color: #666; }
  .ref { color: #666; font-size: 9pt; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .total { display: flex; justify-content: space-between; font-weight: 700; font-size: 12pt; margin-top: 4mm; padding: 3mm; border: 1.5px solid #111; border-radius: 2mm; }
  .list td { border-bottom: 1px solid #eee; }
  .warn { color: #8a5a00; font-size: 9.5pt; }
</style></head>
<body>
<h1>Kartica partnera</h1>
<div class="meta">Period: ${periodText} · Izrađeno ${dateSr(p.generatedOn)} · iznosi u RSD</div>
<div class="parties">${party('Naša firma', p.company)}${party('Partner', p.partner)}</div>
<table>
<thead><tr><th>Datum</th><th>Promena</th><th class="n">Duguje</th><th class="n">Potražuje</th><th class="n">Saldo</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="total"><span>${esc(card.verdict)}${period.to ? ` na ${dateSr(period.to)}` : ''}</span><span>${money(Math.abs(card.closing))}</span></div>
${advances}
${direct}
<script>window.addEventListener('load', function () { window.focus(); window.print(); });</script>
</body></html>`
}
