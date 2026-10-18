import {
  decideOnSef, readSefDecisionResponse, readSefDecisionsEnabled, decisionActions, ci,
  SWITCH_OFF_MESSAGE, COMMENT_REQUIRED_MESSAGE, type FunctionsClientLike,
} from './sefDecide'

/** A client whose `functions.invoke` answers as supabase-js does. */
function clientAnswering(answer: { data?: any; error?: any } | (() => never)) {
  const invoke = jest.fn(async () => {
    if (typeof answer === 'function') return answer()
    return { data: answer.data ?? null, error: answer.error ?? null }
  })
  return { client: { functions: { invoke } } as FunctionsClientLike, invoke }
}

/** What supabase-js hands back for a non-2xx answer: the Response is in `context`. */
const httpError = (status: number, body: unknown) => ({
  message: 'Edge Function returned a non-2xx status code',
  context: { status, json: async () => body },
})

describe('deciding on SEF', () => {
  it('accepts, and says what SEF answered', async () => {
    const { client, invoke } = clientAnswering({ data: {
      ok: true, decision: 'accepted', sef_status: 'Approved', invoice_number: 'F-1',
      decided_at: '2026-10-18T10:00:00Z', decided_by_name: 'Ana',
    } })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(invoke).toHaveBeenCalledWith('sef-decide', { body: { inbox_id: 'row-1', accepted: true, comment: '' } })
    expect(r).toEqual({
      ok: true, decision: 'accepted', sefStatus: 'Approved', invoiceNumber: 'F-1',
      decidedAt: '2026-10-18T10:00:00Z', decidedByName: 'Ana', warning: null,
    })
  })

  it('rejects with the comment trimmed', async () => {
    const { client, invoke } = clientAnswering({ data: { ok: true, decision: 'rejected', sef_status: 'Rejected' } })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: false, comment: '  pogrešan iznos ' })
    expect(invoke).toHaveBeenCalledWith('sef-decide', { body: { inbox_id: 'row-1', accepted: false, comment: 'pogrešan iznos' } })
    expect(r.ok && r.decision).toBe('rejected')
    expect(r.ok && r.sefStatus).toBe('Rejected')
  })

  it('refuses a rejection without a comment before anything is sent', async () => {
    const { client, invoke } = clientAnswering({ data: { ok: true } })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: false, comment: '   ' })
    expect(invoke).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, code: 'comment_required', message: COMMENT_REQUIRED_MESSAGE, httpStatus: null })
  })

  it('says the switch is off', async () => {
    const { client } = clientAnswering({ error: httpError(409, { code: 'switch_off', error: SWITCH_OFF_MESSAGE }) })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(r).toEqual({ ok: false, code: 'switch_off', message: SWITCH_OFF_MESSAGE, httpStatus: 409 })
  })

  it('tells a rejected key apart', async () => {
    const msg = 'SEF je odbio API ključ. Proverite ga.'
    const { client } = clientAnswering({ error: httpError(401, { code: 'key_rejected', error: msg }) })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(r).toEqual({ ok: false, code: 'key_rejected', message: msg, httpStatus: 401 })
  })

  it('reads a 401 with no body as a rejected key', async () => {
    const { client } = clientAnswering({ error: { message: 'x', context: { status: 401, json: async () => { throw new Error('not json') } } } })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('key_rejected')
  })

  it('reports a 500 as a failure, without retrying', async () => {
    const { client, invoke } = clientAnswering({ error: httpError(500, { error: 'boom' }) })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, code: 'failed', message: 'boom', httpStatus: 500 })
  })

  it('reads an unavailable SEF from the status alone', async () => {
    const { client, invoke } = clientAnswering({ error: httpError(504, null) })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, code: 'sef_unavailable', message: 'SEF nije dostupan, pokušajte ponovo.', httpStatus: 504 })
  })

  it('turns a thrown client into a failure, not a crash', async () => {
    const { client } = clientAnswering(() => { throw new Error('offline') })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(r).toEqual({ ok: false, code: 'failed', message: 'offline', httpStatus: null })
  })

  it('passes a history warning through on success', async () => {
    const { client } = clientAnswering({ data: { ok: true, decision: 'accepted', sef_status: 'Approved', record_error: 'Pokušaj nije zapisan' } })
    const r = await decideOnSef(client, { inboxId: 'row-1', accepted: true })
    expect(r.ok && r.warning).toBe('Pokušaj nije zapisan')
  })
})

describe('reading SEF’s answer', () => {
  it('reads the live server’s PascalCase', () => {
    expect(readSefDecisionResponse({
      Message: null, HttpStatus: null, Invoice: { InvoiceNumber: 'F-77', Status: 'Approved' }, Success: true,
    })).toEqual({ success: true, status: 'Approved', invoiceNumber: 'F-77', message: null })
  })

  it('reads the published camelCase', () => {
    expect(readSefDecisionResponse({
      message: 'ok', invoice: { invoiceNumber: 'F-78', status: 'Rejected' }, success: true,
    })).toEqual({ success: true, status: 'Rejected', invoiceNumber: 'F-78', message: 'ok' })
  })

  it('reads a refusal', () => {
    expect(readSefDecisionResponse({ Success: false, Message: 'Invoice not found' }))
      .toEqual({ success: false, status: null, invoiceNumber: null, message: 'Invoice not found' })
  })

  it('returns nulls for anything it cannot read', () => {
    for (const junk of [null, undefined, 'text', 42, [], { Success: 'yes' }]) {
      expect(readSefDecisionResponse(junk)).toEqual({ success: null, status: null, invoiceNumber: null, message: null })
    }
  })

  it('matches keys without regard to case', () => {
    expect(ci({ InVoIcEiD: 3 }, 'invoiceId')).toBe(3)
    expect(ci(null, 'x')).toBeUndefined()
  })
})

describe('the switch', () => {
  const flags = (answer: { data?: any; error?: any } | 'throw') => ({
    from: (table: string) => {
      expect(table).toBe('feature_flags')
      const q: any = {
        select: () => q,
        eq: (col: string, val: string) => { expect([col, val]).toEqual(['name', 'sef_decisions_enabled']); return q },
        maybeSingle: async () => {
          if (answer === 'throw') throw new Error('offline')
          return { data: answer.data ?? null, error: answer.error ?? null }
        },
      }
      return q
    },
  })

  it('is on only when the row says true', async () => {
    expect(await readSefDecisionsEnabled(flags({ data: { enabled: true } }))).toBe(true)
    expect(await readSefDecisionsEnabled(flags({ data: { enabled: false } }))).toBe(false)
  })

  it('is off when the row is missing, unreadable or the read throws', async () => {
    expect(await readSefDecisionsEnabled(flags({ data: null }))).toBe(false)
    expect(await readSefDecisionsEnabled(flags({ error: { message: 'denied' } }))).toBe(false)
    expect(await readSefDecisionsEnabled(flags('throw'))).toBe(false)
  })
})

describe('which buttons a row offers', () => {
  const opened = '2026-10-18T09:00:00Z'
  it('offers nothing before the document is opened', () => {
    expect(decisionActions({ ubl_fetched_at: null, sef_decision: null })).toEqual({ accept: false, reject: false })
  })
  it('offers both on an opened, undecided row', () => {
    expect(decisionActions({ ubl_fetched_at: opened, sef_decision: null })).toEqual({ accept: true, reject: true })
  })
  it('offers only acceptance after a rejection', () => {
    expect(decisionActions({ ubl_fetched_at: opened, sef_decision: 'rejected' })).toEqual({ accept: true, reject: false })
  })
  it('offers nothing after acceptance: it is final', () => {
    expect(decisionActions({ ubl_fetched_at: opened, sef_decision: 'accepted' })).toEqual({ accept: false, reject: false })
  })
})
