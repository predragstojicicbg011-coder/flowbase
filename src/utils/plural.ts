// Serbian plural forms for a count: 1 faktura, 2–4 fakture, 5+ faktura.
//
// The rule follows the last two digits: 11–14 always take the "many" form
// (11 faktura, 12 faktura); otherwise a last digit of 1 takes "one"
// (21 projekat), 2–4 take "few" (22 projekta), and the rest take "many"
// (25 projekata).

export function pluralForm(n: number): 'one' | 'few' | 'many' {
  const abs = Math.abs(Math.trunc(n))
  const lastTwo = abs % 100
  const last = abs % 10
  if (lastTwo >= 11 && lastTwo <= 14) return 'many'
  if (last === 1) return 'one'
  if (last >= 2 && last <= 4) return 'few'
  return 'many'
}

/** The word for `n`: plural(3, 'faktura', 'fakture', 'faktura') → 'fakture'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const form = pluralForm(n)
  return form === 'one' ? one : form === 'few' ? few : many
}

/** The count and the word: countOf(5, 'stavka', 'stavke', 'stavki') → '5 stavki'. */
export function countOf(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`
}
