// ─── multiLink ──────────────────────────────────────────────────────────────
//
// One bill closed by several direct transactions already in the books (a
// bank's fees through the month, then the bank's monthly bill). Each
// transaction pays what it can, in the order chosen, until the bill is
// covered; the last pays only what is left. The P&L stays on the
// transactions, as with one. A bill the transactions do not cover in full is
// left partly closed (the client's decision), its remainder visible.
//
// Amounts are compared in dinars (every transaction has amount_rsd) and
// written in the bill's own currency at the bill's stored rates; the last
// link of a fully covered bill takes the exact remainder, so it closes to the
// cent in its own currency.

import { partBookAmounts, partFromRsd, round2 } from './bookAmounts'

export interface LinkBill {
  amount: number
  amount_rsd: number
  amount_eur: number
  currency: string
  exchange_rate: number
  eur_rate: number
}

export interface AllocatedLink {
  transactionId: string
  allocatedAmount: number
  allocatedAmountRsd: number
  allocatedAmountEur: number
}

export function allocateAcross(
  bill: LinkBill, transactions: { id: string; amount_rsd: number; amount?: number; currency?: string | null }[],
): { links: AllocatedLink[]; covered: number; left: number; unused: string[] } {
  const unused: string[] = []
  const links: AllocatedLink[] = []
  let leftRsd = round2(bill.amount_rsd)
  let leftOwn = round2(bill.amount)
  let leftEur = round2(bill.amount_eur)
  for (const t of transactions) {
    if (leftRsd <= 0.005) { unused.push(t.id); continue }
    // In the bill's own currency the transaction pays its own figure: two
    // booking rates of one currency must not leave a dinar remainder.
    const sameCurrency = t.amount != null && (t.currency || 'RSD') === (bill.currency || 'RSD')
    let part: { amount: number; amount_rsd: number; amount_eur: number }
    if (sameCurrency) {
      const own = round2(Math.min(Math.abs(Number(t.amount) || 0), leftOwn))
      if (own <= 0) { unused.push(t.id); continue }
      part = Math.abs(own - leftOwn) <= 0.005
        ? { amount: leftOwn, amount_rsd: leftRsd, amount_eur: leftEur }
        : { amount: own, ...partBookAmounts(own, bill) }
    } else {
      const rsd = round2(Math.min(Math.abs(Number(t.amount_rsd) || 0), leftRsd))
      if (rsd <= 0) { unused.push(t.id); continue }
      part = Math.abs(rsd - leftRsd) <= 0.005
        ? { amount: leftOwn, amount_rsd: leftRsd, amount_eur: leftEur }
        : partFromRsd(rsd, bill)
    }
    links.push({ transactionId: t.id, allocatedAmount: part.amount, allocatedAmountRsd: part.amount_rsd, allocatedAmountEur: part.amount_eur })
    leftRsd = round2(leftRsd - part.amount_rsd)
    leftOwn = round2(leftOwn - part.amount)
    leftEur = round2(leftEur - part.amount_eur)
  }
  return { links, covered: round2(bill.amount - leftOwn), left: leftOwn, unused }
}
