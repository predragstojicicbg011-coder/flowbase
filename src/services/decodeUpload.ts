// ─── decodeUpload ───────────────────────────────────────────────────────────
//
// What encoding a statement file is actually in.
//
// `File.text()` always decodes as UTF-8. That is the right default for most of
// the world and the wrong one for a Serbian bank: statements come out of the
// domestic banking software in windows-1250, where `Ć` is the single byte 0xC6.
// 0xC6 on its own is not valid UTF-8, so the decoder replaces it — and
// `POVRAĆAJ POZAJMICE` arrives as `POVRA<?>AJ POZAJMICE`, with the character
// gone for good. Nothing downstream can put it back: U+FFFD carries no record
// of what it replaced.
//
// So the encoding is decided before the decode, not repaired after it.
//
// THE TEST IS UTF-8 ITSELF. Valid UTF-8 is a tightly constrained byte
// grammar — continuation bytes have to follow lead bytes in exactly the right
// counts — and text carrying Serbian diacritics in windows-1250 essentially
// never satisfies it by accident. So: decode strictly as UTF-8, and if that
// throws, the file is single-byte and windows-1250 is the regional answer.
// That covers Ć Č Š Ž Đ and their lower case, which is the whole of what goes
// missing.
//
// This cannot be perfect and does not pretend to be. A windows-1250 file whose
// bytes happen to form valid UTF-8 is indistinguishable, and would have to be
// pure ASCII plus a coincidence. Pure ASCII decodes identically either way, so
// the coincidence costs nothing.

/** What a decode decided, so a caller can say so rather than guess. */
export interface Decoded {
  text: string
  encoding: 'utf-8' | 'windows-1250'
  /** True when the bytes were not valid UTF-8 and the fallback was used. */
  fellBack: boolean
}

/** A UTF-8 byte order mark, which settles the question before it is asked. */
const BOM = [0xef, 0xbb, 0xbf]

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
}

/**
 * Whether these bytes are valid UTF-8.
 *
 * `fatal` is what makes this a question rather than a formality: without it
 * the decoder answers with replacement characters and no error, which is the
 * behaviour being worked around in the first place.
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * The text of an uploaded statement, in whichever encoding it is really in.
 *
 * Returns the encoding it settled on so the import can report it — a file
 * silently read as the wrong thing is how this was missed for months.
 */
export function decodeStatement(buffer: ArrayBuffer | Uint8Array): Decoded {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  if (hasUtf8Bom(bytes) || isValidUtf8(bytes)) {
    // `utf-8` here is not fatal and strips the BOM, which is what we want:
    // the question has already been answered.
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', fellBack: false }
  }

  try {
    return {
      text: new TextDecoder('windows-1250').decode(bytes),
      encoding: 'windows-1250',
      fellBack: true,
    }
  } catch {
    // A runtime without the single-byte encodings. Rather than throw away the
    // upload, decode leniently as UTF-8 — the same result as before this
    // module existed, which is a bad answer but not a lost file.
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', fellBack: true }
  }
}

/**
 * Whether a string already carries the damage.
 *
 * U+FFFD is unrecoverable — it does not record what it replaced — so this is
 * for warning about text on its way in, not for repairing text already stored.
 */
export function hasLostCharacters(text: string): boolean {
  return text.includes('�')
}
