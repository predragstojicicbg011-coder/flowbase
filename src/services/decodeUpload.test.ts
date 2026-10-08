import { decodeStatement, hasLostCharacters, isValidUtf8 } from './decodeUpload'

const utf8 = (s: string) => new TextEncoder().encode(s)

/**
 * The same text in windows-1250, byte for byte. Each Serbian letter is one
 * byte there, which is exactly why UTF-8 cannot read it.
 *
 *   Ć 0xC6   Č 0xC8   Š 0x8A   Ž 0x8E   Đ 0xD0
 */
const win1250 = (...bytes: number[]) => new Uint8Array(bytes)

// "POVRAĆAJ POZAJMICE" — the line that arrives broken.
const POVRACAJ = win1250(
  0x50, 0x4f, 0x56, 0x52, 0x41, 0xc6, 0x41, 0x4a, 0x20,
  0x50, 0x4f, 0x5a, 0x41, 0x4a, 0x4d, 0x49, 0x43, 0x45)

describe('isValidUtf8', () => {
  it('accepts plain ASCII, which is valid either way', () => {
    expect(isValidUtf8(utf8('UPLATA PO FAKTURI 26-03-835052'))).toBe(true)
  })

  it('accepts real UTF-8 with the same letters in it', () => {
    expect(isValidUtf8(utf8('POVRAĆAJ POZAJMICE'))).toBe(true)
  })

  it('rejects a lone high byte, which is what windows-1250 is made of', () => {
    expect(isValidUtf8(POVRACAJ)).toBe(false)
  })

  it('rejects a truncated multi-byte sequence', () => {
    expect(isValidUtf8(win1250(0xc4, 0x86, 0xc4))).toBe(false)
  })

  it('has no trouble with nothing at all', () => {
    expect(isValidUtf8(new Uint8Array([]))).toBe(true)
  })
})

describe('decodeStatement', () => {
  it('reads a UTF-8 file as UTF-8 and says so', () => {
    const out = decodeStatement(utf8('POVRAĆAJ POZAJMICE'))
    expect(out.text).toBe('POVRAĆAJ POZAJMICE')
    expect(out.encoding).toBe('utf-8')
    expect(out.fellBack).toBe(false)
  })

  it('recovers the letter windows-1250 was losing', () => {
    // THE BUG: `file.text()` turned this byte into U+FFFD and the character
    // was gone for good.
    const out = decodeStatement(POVRACAJ)
    expect(out.text).toBe('POVRAĆAJ POZAJMICE')
    expect(out.encoding).toBe('windows-1250')
    expect(out.fellBack).toBe(true)
  })

  it('recovers the rest of the Serbian alphabet too', () => {
    // Č Š Ž Đ č š ž đ — everything a bank narrative actually contains.
    const out = decodeStatement(win1250(0xc8, 0x8a, 0x8e, 0xd0, 0xe8, 0x9a, 0x9e, 0xf0))
    expect(out.text).toBe('ČŠŽĐčšžđ')
  })

  it('never returns a replacement character for a file it could decode', () => {
    expect(hasLostCharacters(decodeStatement(POVRACAJ).text)).toBe(false)
  })

  it('strips a UTF-8 byte order mark instead of leaving it in the first field', () => {
    // A BOM left in place makes the first column header not match anything,
    // which is its own quiet parsing failure.
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Array.from(utf8('Datum;Iznos'))])
    const out = decodeStatement(withBom)
    expect(out.text).toBe('Datum;Iznos')
    expect(out.encoding).toBe('utf-8')
  })

  it('reads pure ASCII identically whichever way it is taken', () => {
    const ascii = 'DATE;DESCRIPTION;DEBIT;CREDIT\n2026-09-21;JKP PARKING;1500;'
    expect(decodeStatement(utf8(ascii)).text).toBe(ascii)
  })

  it('accepts an ArrayBuffer as readily as the bytes', () => {
    const bytes = utf8('POVRAĆAJ')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    expect(decodeStatement(buffer as ArrayBuffer).text).toBe('POVRAĆAJ')
  })

  it('returns an empty string for an empty file rather than throwing', () => {
    expect(decodeStatement(new Uint8Array([])).text).toBe('')
  })

  it('keeps the separators a parser depends on', () => {
    // Whatever the encoding decision, the structure has to survive it.
    const out = decodeStatement(win1250(
      0x41, 0x3b, 0xc6, 0x3b, 0x42, 0x0d, 0x0a, 0x43))
    expect(out.text).toBe('A;Ć;B\r\nC')
  })
})

describe('hasLostCharacters', () => {
  it('spots text that has already lost a character', () => {
    expect(hasLostCharacters('POVRA�AJ POZAJMICE')).toBe(true)
  })

  it('says nothing about text that is intact', () => {
    expect(hasLostCharacters('POVRAĆAJ POZAJMICE')).toBe(false)
    expect(hasLostCharacters('')).toBe(false)
  })
})
