import { sefStatusWord, sefStatusTone } from './sefStatusWords'

describe('sefStatusWord and sefStatusTone', () => {
  it.each([
    ['New', 'Nova', 'blue'],
    ['Seen', 'Pregledana', 'amber'],
    ['ReNotified', 'Ponovo obaveštena', 'amber'],
    ['Approved', 'Odobrena', 'green'],
    ['Rejected', 'Odbijena', 'red'],
    ['Cancelled', 'Otkazana', 'grey'],
    ['Storno', 'Stornirana', 'grey'],
    ['Sent', 'Poslata', 'blue'],
    ['Paid', 'Plaćena', 'green'],
    ['Mistake', 'Greška', 'red'],
    ['Draft', 'Nacrt', 'grey'],
    ['Sending', 'U slanju', 'amber'],
  ])('%s is %s in %s', (raw, word, tone) => {
    expect(sefStatusWord(raw)).toBe(word)
    expect(sefStatusTone(raw)).toBe(tone)
  })

  it('ignores case and surrounding spaces', () => {
    expect(sefStatusWord('  SEEN ')).toBe('Pregledana')
    expect(sefStatusTone('  SEEN ')).toBe('amber')
    expect(sefStatusWord('renotified')).toBe('Ponovo obaveštena')
  })

  it('shows a value SEF adds later as received, in a neutral tone', () => {
    expect(sefStatusWord(' Quarantined ')).toBe('Quarantined')
    expect(sefStatusTone('Quarantined')).toBe('neutral')
  })

  it('has no word for blank or null', () => {
    expect(sefStatusWord(null)).toBeNull()
    expect(sefStatusWord(undefined)).toBeNull()
    expect(sefStatusWord('')).toBeNull()
    expect(sefStatusWord('   ')).toBeNull()
    expect(sefStatusTone(null)).toBe('neutral')
  })
})
