import {
  LEGACY_REVENUE_STREAMS, REVENUE_STREAM, REVENUE_STREAMS, isRevenueStream, normaliseRevenueStream,
} from './revenueStreams'
import { REVENUE_STREAMS as LEDGER_STREAMS } from './ledgerFilters'
import * as fs from 'fs'
import * as path from 'path'

describe('revenue streams', () => {
  it('is the construction company list, in Serbian, in picker order', () => {
    expect(REVENUE_STREAMS).toEqual([
      'Građevinske situacije', 'Zakup', 'Povraćaj PDV-a', 'Prihod od kamata', 'Krediti', 'Ostalo',
    ])
  })

  it('is the list the Ledger filters offer', () => {
    expect(LEDGER_STREAMS).toBe(REVENUE_STREAMS)
  })

  it('recognises only current values', () => {
    expect(isRevenueStream('Zakup')).toBe(true)
    expect(isRevenueStream('Aimfox')).toBe(false)
    expect(isRevenueStream(null)).toBe(false)
  })

  it('maps every Mintflow value onto a current one', () => {
    for (const v of Object.values(LEGACY_REVENUE_STREAMS)) expect(isRevenueStream(v)).toBe(true)
    expect(normaliseRevenueStream('Aimfox')).toBe(REVENUE_STREAM.construction)
    expect(normaliseRevenueStream('social_growth')).toBe(REVENUE_STREAM.construction)
    expect(normaliseRevenueStream('VAT Claimed')).toBe(REVENUE_STREAM.vatRefund)
    expect(normaliseRevenueStream('Interest Received')).toBe(REVENUE_STREAM.interest)
    expect(normaliseRevenueStream('Loans')).toBe(REVENUE_STREAM.loans)
    expect(normaliseRevenueStream('Credit')).toBe(REVENUE_STREAM.loans)
    expect(normaliseRevenueStream('Other')).toBe(REVENUE_STREAM.other)
  })

  it('keeps current values, empties to null, and does not guess at the unknown', () => {
    expect(normaliseRevenueStream(' Zakup ')).toBe('Zakup')
    expect(normaliseRevenueStream('')).toBeNull()
    expect(normaliseRevenueStream(undefined)).toBeNull()
    expect(normaliseRevenueStream('Nešto treće')).toBeNull()
  })

  it('matches the CHECK the migration puts on the database', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../../supabase/migrations/20261008170000_projects.sql'), 'utf8')
    // On invoices: revenue_entries, which carried the same CHECK, was dropped
    // in 20261008180000.
    const check = sql.match(/add constraint invoices_revenue_stream_check\s+check \(revenue_stream is null or revenue_stream = any \(array\[([^\]]+)\]/)
    expect(check).not.toBeNull()
    const values = check![1].split(',').map(s => s.trim().replace(/::text$/, '').replace(/^'|'$/g, ''))
    expect(values).toEqual([...REVENUE_STREAMS])
  })
})

describe('streamForProjectKind', () => {
  const { streamForProjectKind } = require('./revenueStreams')
  it('a site bills progress, a building rent', () => {
    expect(streamForProjectKind('construction')).toBe('Građevinske situacije')
    expect(streamForProjectKind('rental')).toBe('Zakup')
    expect(streamForProjectKind(null)).toBeNull()
    expect(streamForProjectKind('other')).toBeNull()
  })
})
