// ─── Otisak izvornog reda iz uvezenog fajla ─────────────────────────────────
// Sluzi kao prirodni kljuc za idempotentan import: ponovni uvoz istog izvoda
// daje iste hasheve i biva odbijen unique indeksom (vidi migraciju
// 20260826100000_import_idempotency.sql).
//
// VAZNO: u otisak ULAZI redni broj reda u fajlu. Bez toga bi dvije legitimno
// identicne stavke u istom izvodu — npr. dvije iste provizije istog dana —
// dobile isti hash i druga bi bila tiho odbacena kao "duplikat".

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

type HashPart = string | number | null | undefined

/**
 * Gradi otisak iz dijelova izvornog reda. Dijelovi se spajaju kontrolnim
 * znakom koji se ne pojavljuje u podacima, da "AB" + "C" i "A" + "BC" ne bi
 * dali isti otisak.
 */
export async function importRowHash(parts: HashPart[]): Promise<string> {
  const normalized = parts
    .map(p => (p === null || p === undefined ? '' : String(p).trim()))
    .join('')
  return sha256Hex(normalized)
}
