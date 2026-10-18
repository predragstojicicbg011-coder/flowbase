import {
  validateSefKey, mapSefKeyStatus, readSefKeyStatus, describeSefKeyStatus, formatSetAt,
  saveSefKey, checkSefConnection, mapSefCheckSuccess,
  KEY_EMPTY_MESSAGE, KEY_SHAPE_MESSAGE, ENVIRONMENT_MESSAGE, KEY_REJECTED_MESSAGE, SEF_UNAVAILABLE_MESSAGE,
  NOT_CONFIGURED, type RpcClientLike, type FunctionsClientLike,
} from './sefKey'

const KEY = '462d9282-22cf-4d0b-afbe-17411d375a18'

const rpcClient = (answer: { data?: any; error?: any }) => {
  const rpc = jest.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }))
  return { client: { rpc } as unknown as RpcClientLike, rpc }
}

const fnClient = (answer: { data?: any; error?: any } | (() => never)) => {
  const invoke = jest.fn(async () => {
    if (typeof answer === 'function') return answer()
    return { data: answer.data ?? null, error: answer.error ?? null }
  })
  return { client: { functions: { invoke } } as FunctionsClientLike, invoke }
}

const httpError = (status: number, body: unknown) => ({
  message: 'Edge Function returned a non-2xx status code',
  context: { status, json: async () => body },
})

describe('validating a SEF key (mirrors sef_set_api_key)', () => {
  it('accepts a UUID-shaped key, trimmed, either case', () => {
    expect(validateSefKey(`  ${KEY}  `, 'production')).toBeNull()
    expect(validateSefKey(KEY.toUpperCase(), 'demo')).toBeNull()
  })
  it('refuses an empty key', () => {
    expect(validateSefKey('   ', 'production')).toBe(KEY_EMPTY_MESSAGE)
  })
  it('refuses something that is not a SEF key', () => {
    expect(validateSefKey('abc123', 'production')).toBe(KEY_SHAPE_MESSAGE)
    expect(validateSefKey(KEY.replace(/-/g, ''), 'production')).toBe(KEY_SHAPE_MESSAGE)
    expect(validateSefKey(`${KEY}x`, 'production')).toBe(KEY_SHAPE_MESSAGE)
  })
  it('refuses an unknown environment', () => {
    expect(validateSefKey(KEY, 'staging')).toBe(ENVIRONMENT_MESSAGE)
  })
})

describe('the key status', () => {
  it('maps the row sef_key_status returns', () => {
    expect(mapSefKeyStatus([{
      configured: true, environment: 'production', last4: '5a18',
      set_at: '2026-10-18T18:15:00Z', set_by_name: 'Ana', company_id: 'c1', company_name: 'Firma doo',
    }])).toEqual({
      configured: true, environment: 'production', last4: '5a18',
      setAt: '2026-10-18T18:15:00Z', setByName: 'Ana', companyId: 'c1', companyName: 'Firma doo',
    })
  })
  it('never keeps more than four characters, whatever comes back', () => {
    expect(mapSefKeyStatus({ configured: true, environment: 'demo', last4: KEY }).last4).toBe('5a18')
  })
  it('reads anything but configured: true as not configured', () => {
    expect(mapSefKeyStatus(null)).toEqual(NOT_CONFIGURED)
    expect(mapSefKeyStatus([])).toEqual(NOT_CONFIGURED)
    expect(mapSefKeyStatus([{ configured: false, last4: '1234' }])).toEqual(NOT_CONFIGURED)
  })
  it('says what failed when the status cannot be read', async () => {
    const { client, rpc } = rpcClient({ error: { message: 'nope' } })
    const r = await readSefKeyStatus(client)
    expect(rpc).toHaveBeenCalledWith('sef_key_status')
    expect(r.status.configured).toBe(false)
    expect(r.error).toMatch(/nope/)
  })
  it('describes it in one line', () => {
    expect(describeSefKeyStatus(NOT_CONFIGURED)).toBe('Ključ nije podešen')
    expect(describeSefKeyStatus({
      ...NOT_CONFIGURED, configured: true, environment: 'production', last4: '1234',
      setByName: 'Ime', setAt: '2026-10-18T18:15:00Z',
    })).toBe('Ključ je podešen (…1234), produkcija — postavio Ime, 18.10.2026. 20:15')
    expect(describeSefKeyStatus({ ...NOT_CONFIGURED, configured: true, environment: 'demo', last4: '9f00' }))
      .toBe('Ključ je podešen (…9f00), demo')
  })
  it('formats the time in Belgrade', () => {
    expect(formatSetAt('2026-01-05T08:07:00Z')).toBe('05.01.2026. 09:07')
    expect(formatSetAt(null)).toBeNull()
    expect(formatSetAt('not a date')).toBeNull()
  })
})

describe('saving the key', () => {
  it('sends the trimmed key and the environment', async () => {
    const { client, rpc } = rpcClient({})
    const r = await saveSefKey(client, `  ${KEY} `, 'demo')
    expect(rpc).toHaveBeenCalledWith('sef_set_api_key', { p_api_key: KEY, p_environment: 'demo' })
    expect(r).toEqual({ ok: true, message: null })
  })
  it('names the company when one is chosen', async () => {
    const { client, rpc } = rpcClient({})
    await saveSefKey(client, KEY, 'production', 'c2')
    expect(rpc).toHaveBeenCalledWith('sef_set_api_key', { p_api_key: KEY, p_environment: 'production', p_company_id: 'c2' })
  })
  it('refuses before the round trip what the database would refuse', async () => {
    const { client, rpc } = rpcClient({})
    expect(await saveSefKey(client, 'kljuc', 'production')).toEqual({ ok: false, message: KEY_SHAPE_MESSAGE })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('passes on the refusal of a non-administrator', async () => {
    const { client } = rpcClient({ error: { code: '42501', message: 'SEF API ključ podešava samo administrator.' } })
    expect(await saveSefKey(client, KEY, 'production'))
      .toEqual({ ok: false, message: 'SEF API ključ podešava samo administrator.' })
  })
})

describe('checking the connection', () => {
  it('reports how many invoices arrived today', async () => {
    const { client, invoke } = fnClient({ data: { ok: true, environment: 'production', invoices_seen: 3 } })
    const r = await checkSefConnection(client)
    expect(invoke).toHaveBeenCalledWith('sef-check', { body: {} })
    expect(r).toEqual({
      ok: true, environment: 'production', invoicesSeen: 3,
      message: 'Veza sa SEF-om radi. Danas pristiglih faktura: 3.',
    })
  })
  it('reads a missing count as zero', () => {
    expect(mapSefCheckSuccess({ ok: true }).ok && mapSefCheckSuccess({ ok: true })).toMatchObject({ invoicesSeen: 0 })
  })
  it('says the key was refused on 401 and 403', async () => {
    for (const status of [401, 403]) {
      const { client } = fnClient({ error: httpError(status, { ok: false, code: 'key_rejected', error: KEY_REJECTED_MESSAGE }) })
      expect(await checkSefConnection(client)).toEqual({ ok: false, code: 'key_rejected', message: KEY_REJECTED_MESSAGE, httpStatus: status })
    }
  })
  it('falls back on the status when the body cannot be read', async () => {
    const { client } = fnClient({ error: { message: 'x', context: { status: 403, json: async () => { throw new Error('no body') } } } })
    expect(await checkSefConnection(client)).toMatchObject({ ok: false, code: 'key_rejected', message: KEY_REJECTED_MESSAGE })
    const five = fnClient({ error: { message: 'x', context: { status: 502 } } })
    expect(await checkSefConnection(five.client)).toMatchObject({ ok: false, code: 'sef_unavailable', message: SEF_UNAVAILABLE_MESSAGE })
  })
  it('says SEF is unavailable when the call itself throws', async () => {
    const { client } = fnClient(() => { throw new Error('network') })
    expect(await checkSefConnection(client)).toMatchObject({ ok: false, message: SEF_UNAVAILABLE_MESSAGE })
  })
  it('passes on a named refusal such as a missing key', async () => {
    const { client } = fnClient({ error: httpError(400, { ok: false, code: 'no_credentials', error: 'SEF ključ nije podešen.' }) })
    expect(await checkSefConnection(client)).toEqual({ ok: false, code: 'no_credentials', message: 'SEF ključ nije podešen.', httpStatus: 400 })
  })
})
