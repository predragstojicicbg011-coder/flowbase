import {
  fetchPreliminaryHours, savePreliminaryHours, removePreliminaryHours,
} from './preliminaryHoursStore'
import { proposeFromCalendar, TEMPLATE_FIELDS } from './preliminaryHours'
import { TEMPLATE_NOT_SAVED, TEMPLATE_NOT_REMOVED, templateNotRead } from './preliminaryText'
import { fundFor } from './holidays'

const TEMPLATE = proposeFromCalendar('2026-11', fundFor('2026-11',
  [{ holiday_on: '2026-11-11', name: 'Praznik A', kind: 'state' }], null, null))

/** A fake client that records each call and answers what it is told to. */
function client(answer: { data?: any; error?: any } = {}) {
  const calls: any[] = []
  const chain: any = {
    select: (cols: string) => { calls.push(['select', cols]); return chain },
    eq: (c: string, v: any) => { calls.push(['eq', c, v]); return chain },
    maybeSingle: async () => ({ data: answer.data ?? null, error: answer.error ?? null }),
    upsert: (row: any, opts: any) => {
      calls.push(['upsert', row, opts])
      return {
        select: async (cols: string) => {
          calls.push(['select', cols])
          return { data: answer.data ?? null, error: answer.error ?? null }
        },
      }
    },
    delete: () => { calls.push(['delete']); return chain },
    // Awaiting the chain itself is what `delete().eq().select()` does.
    then: (resolve: (v: any) => void) =>
      resolve({ data: answer.data ?? null, error: answer.error ?? null }),
  }
  return {
    calls,
    from: (table: string) => { calls.push(['from', table]); return chain },
  }
}

describe('the template, stored', () => {
  it('reads one month, numbers as numbers', async () => {
    const c = client({ data: { ...TEMPLATE, regular_hours: '160', holiday_hours: '8' } })
    const row = await fetchPreliminaryHours(c, '2026-11')
    expect(c.calls).toEqual([
      ['from', 'payroll_preliminary_hours'], ['select', '*'], ['eq', 'month', '2026-11-01'],
    ])
    expect(row?.regular_hours).toBe(160)
    expect(row?.holiday_hours).toBe(8)
  })

  it('no row is no template, and a failed read is said', async () => {
    expect(await fetchPreliminaryHours(client(), '2026-11')).toBeNull()
    await expect(fetchPreliminaryHours(client({ error: { message: 'odbijeno' } }), '2026-11'))
      .rejects.toThrow(templateNotRead('odbijeno'))
  })

  it('a save that wrote nothing says so', async () => {
    await expect(savePreliminaryHours(client({ data: [] }), TEMPLATE)).rejects.toThrow(TEMPLATE_NOT_SAVED)
    await expect(savePreliminaryHours(client({ error: { message: 'check_violation' } }), TEMPLATE))
      .rejects.toThrow(TEMPLATE_NOT_SAVED)
  })

  it('sends every hour category, and never who saved it', async () => {
    const c = client({ data: [{ month: '2026-11-01' }] })
    await savePreliminaryHours(c, { ...TEMPLATE, saved_by: 'neko', saved_at: 'tada' })
    const [, row, opts] = c.calls.find(x => x[0] === 'upsert')
    expect(opts).toEqual({ onConflict: 'month' })
    expect(row).not.toHaveProperty('saved_by')
    expect(row).not.toHaveProperty('saved_at')
    expect(row.month).toBe('2026-11-01')
    for (const f of TEMPLATE_FIELDS) expect(row).toHaveProperty(f)
    expect(Object.keys(row).sort()).toEqual(['month', 'note', ...TEMPLATE_FIELDS].sort())
  })

  it('removes the running month by its first day', async () => {
    const c = client({ data: [{ month: '2026-11-01' }] })
    await removePreliminaryHours(c, '2026-11')
    expect(c.calls).toEqual([
      ['from', 'payroll_preliminary_hours'], ['delete'], ['eq', 'month', '2026-11-01'], ['select', 'month'],
    ])
  })

  it('a refused removal, or one that removed nothing, says so', async () => {
    await expect(removePreliminaryHours(client({ error: { message: 'odbijeno' } }), '2026-11'))
      .rejects.toThrow(TEMPLATE_NOT_REMOVED)
    await expect(removePreliminaryHours(client({ data: [] }), '2026-11')).rejects.toThrow(TEMPLATE_NOT_REMOVED)
  })
})
