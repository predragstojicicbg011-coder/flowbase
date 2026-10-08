// ── Reading a by-value split back in dollars ─────────────────────────────────
//
// Four columns hold the splits a user types by hand: rev_alloc_sg /
// rev_alloc_aimfox for the revenue streams, opex_amount / performance_amount
// for the expense type. All four are entered, and stored, in the currency of
// the bill. That is deliberate and it should stay: the dialogs label the
// inputs `Social Growth (RSD)`, check the two halves against the RSD total,
// and seed them back from the stored value when the row is reopened. Asking
// someone looking at a 220,996 RSD invoice to split it in dollars would be
// asking them to do the conversion in their head.
//
// The P&L prints those figures beside amount_usd, which is dollars. Read raw,
// a 220,996 RSD bill split 120,000 / 100,996 printed as $120,000 and $100,996
// against a true total of $2,188. The total column was never wrong - it goes
// through amount_usd - so the page contradicted itself line by line.
//
// So the conversion belongs here, on read. The row already carries the factor:
// amount_usd over amount is dollars per unit of whatever the row is in, at the
// rate the row was booked with. Not today's rate, not a second lookup - the
// same rate that produced the total the split has to add up to. That is the
// whole reason this is derived from the row rather than fetched: it makes
// `sg + af = amount_usd` true by construction.

/** The fields of a P&L entry this module reads. Everything else is ignored. */
export interface AllocEntry {
  amount?: number | null
  amount_usd?: number | null
  rev_alloc_type?: string | null
  rev_alloc_sg?: number | null
  rev_alloc_aimfox?: number | null
  opex_type?: string | null
  opex_amount?: number | null
  performance_amount?: number | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * USD per unit of the row's own currency, from what the row already carries.
 *
 * A USD row gives 1, because its two amounts are equal. Anything the factor
 * cannot be computed from - no `amount`, a zero `amount`, a view that predates
 * the migration carrying it - gives 1 as well, which leaves the stored figure
 * exactly as it reads today. That is the wrong number for a foreign-currency
 * row, but it is the number the page printed before this existed, and it is
 * finite: dividing by a missing or zero amount would otherwise put Infinity or
 * NaN into a column of money and poison every total it is added to.
 */
export function usdFactor(e: AllocEntry): number {
  const amount = e.amount
  const usd = e.amount_usd
  if (!finite(amount) || amount === 0) return 1
  if (!finite(usd)) return 1
  const factor = usd / amount
  return Number.isFinite(factor) ? factor : 1
}

/**
 * One revenue stream's share of an entry, in USD.
 *
 * `sg100` and `af100` hand the whole row to one stream and are already in USD,
 * so the factor never touches them. Only the two typed figures of a `byval`
 * split are converted; where one of them was never filled in, the half of
 * `amount_usd` that stands in for it is USD already.
 */
export function allocAmount(e: AllocEntry, stream: 'sg' | 'af'): number {
  const amt = e.amount_usd || 0
  if (e.rev_alloc_type === 'sg100') return stream === 'sg' ? amt : 0
  if (e.rev_alloc_type === 'af100') return stream === 'af' ? amt : 0
  if (e.rev_alloc_type === 'byval') {
    const f = usdFactor(e)
    // Null check, not falsy - 0 is a valid allocation, and 0 * f is still 0.
    const raw = stream === 'af' ? e.rev_alloc_aimfox : e.rev_alloc_sg
    return raw != null ? raw * f : amt / 2
  }
  return amt / 2
}

/**
 * The OPEX or performance share of an expense, in USD.
 *
 * Same shape as the revenue split and the same rule: only the two typed
 * figures of a `split` are in the bill's currency. An entry with no
 * `opex_type` at all is treated as pure OPEX, which is what the page has
 * always done with rows classified before the field existed.
 */
export function opexAlloc(e: AllocEntry, type: 'opex' | 'performance'): number {
  const amt = e.amount_usd || 0
  if (!e.opex_type || e.opex_type === 'opex') return type === 'opex' ? amt : 0
  if (e.opex_type === 'performance') return type === 'performance' ? amt : 0
  if (e.opex_type === 'split') {
    const f = usdFactor(e)
    const raw = type === 'opex' ? e.opex_amount : e.performance_amount
    return raw != null ? raw * f : amt / 2
  }
  return type === 'opex' ? amt : 0
}
