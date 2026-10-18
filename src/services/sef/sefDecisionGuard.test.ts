import {
  sefDecisionGuard, sefOutsideBadge, sefStatusRank, sefAlreadyDecidedRefusal,
  ACCEPTED_OUTSIDE_MESSAGE, REJECTED_OUTSIDE_MESSAGE, WITHDRAWN_MESSAGE,
} from './sefDecisionGuard'

const row = (sef_status: string | null, sef_decision: 'accepted' | 'rejected' | null = null) => ({ sef_status, sef_decision })

describe('sefDecisionGuard', () => {
  it('lets New, Seen and ReNotified through either way', () => {
    for (const st of ['New', 'Seen', 'ReNotified', null]) {
      expect(sefDecisionGuard(row(st), true)).toBeNull()
      expect(sefDecisionGuard(row(st), false)).toBeNull()
    }
  })

  it('refuses both on an invoice accepted outside the app', () => {
    expect(sefDecisionGuard(row('Approved'), true)).toEqual({ code: 'accepted_outside', message: ACCEPTED_OUTSIDE_MESSAGE })
    expect(sefDecisionGuard(row('Approved'), false)?.code).toBe('accepted_outside')
  })

  it('leaves the app own acceptance to its own message', () => {
    expect(sefDecisionGuard(row('Approved', 'accepted'), true)).toBeNull()
  })

  it('refuses a second rejection of an invoice rejected outside, but allows accepting it', () => {
    expect(sefDecisionGuard(row('Rejected'), false)).toEqual({ code: 'rejected_outside', message: REJECTED_OUTSIDE_MESSAGE })
    expect(sefDecisionGuard(row('Rejected'), true)).toBeNull()
  })

  it('refuses everything on a cancelled or stornoed invoice, whoever decided before', () => {
    for (const st of ['Cancelled', 'Storno', 'storno']) {
      for (const d of [null, 'rejected', 'accepted'] as const) {
        expect(sefDecisionGuard(row(st, d), true)).toEqual({ code: 'withdrawn', message: WITHDRAWN_MESSAGE })
        expect(sefDecisionGuard(row(st, d), false)?.code).toBe('withdrawn')
      }
    }
  })

  it('ignores case and stray spaces in the status', () => {
    expect(sefDecisionGuard(row(' approved '), true)?.code).toBe('accepted_outside')
  })
})

describe('sefOutsideBadge', () => {
  it('marks a decision made outside the app', () => {
    expect(sefOutsideBadge(row('Approved'))?.label).toBe('Odlučeno van aplikacije')
    expect(sefOutsideBadge(row('Rejected'))?.label).toBe('Odlučeno van aplikacije')
  })
  it('does not mark the app own decisions', () => {
    expect(sefOutsideBadge(row('Approved', 'accepted'))).toBeNull()
    expect(sefOutsideBadge(row('Rejected', 'rejected'))).toBeNull()
  })
  it('marks storno and cancellation', () => {
    expect(sefOutsideBadge(row('Storno'))).toEqual({ label: 'Storno', tone: 'red' })
    expect(sefOutsideBadge(row('Cancelled'))).toEqual({ label: 'Otkazana', tone: 'red' })
  })
  it('says nothing about undecided rows', () => {
    expect(sefOutsideBadge(row('Seen'))).toBeNull()
    expect(sefOutsideBadge(row(null))).toBeNull()
  })
})

describe('sefStatusRank', () => {
  it('puts New first', () => {
    expect(sefStatusRank('New')).toBeLessThan(sefStatusRank('Seen'))
    expect(sefStatusRank('new')).toBe(0)
    expect(sefStatusRank(null)).toBe(1)
  })
})

describe('sefAlreadyDecidedRefusal', () => {
  it('reads the status SEF reports on the invoice', () => {
    expect(sefAlreadyDecidedRefusal('Approved', null, false)?.code).toBe('accepted_outside')
    expect(sefAlreadyDecidedRefusal('Rejected', null, false)?.code).toBe('rejected_outside')
    expect(sefAlreadyDecidedRefusal('Rejected', null, true)).toBeNull()
    expect(sefAlreadyDecidedRefusal('Storno', null, true)?.code).toBe('withdrawn')
  })
  it('reads SEF text when there is no status', () => {
    expect(sefAlreadyDecidedRefusal(null, 'Invoice is already approved.', true)?.message).toBe(ACCEPTED_OUTSIDE_MESSAGE)
    expect(sefAlreadyDecidedRefusal(null, 'Faktura je već prihvaćena', false)?.code).toBe('accepted_outside')
    expect(sefAlreadyDecidedRefusal(null, 'Invoice already rejected', false)?.message).toBe(REJECTED_OUTSIDE_MESSAGE)
    expect(sefAlreadyDecidedRefusal(null, 'Invoice has been cancelled', true)?.message).toBe(WITHDRAWN_MESSAGE)
  })
  it('leaves other refusals alone', () => {
    expect(sefAlreadyDecidedRefusal(null, 'Comment is required', false)).toBeNull()
    expect(sefAlreadyDecidedRefusal(null, null, true)).toBeNull()
    expect(sefAlreadyDecidedRefusal(null, 'Invoice already rejected', true)).toBeNull()
  })
})
