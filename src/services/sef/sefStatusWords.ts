// The one place that turns SEF's raw invoice status into a word and a tone,
// so every screen that shows the status says the same thing. Display only:
// nothing here decides what may be done with an invoice (see sefDecisionGuard).

export type SefStatusTone = 'blue' | 'amber' | 'green' | 'red' | 'grey' | 'neutral'

const WORDS: Record<string, { word: string; tone: SefStatusTone }> = {
  // Purchase side: what the owner still has to decide, and what is decided.
  new: { word: 'Nova', tone: 'blue' },
  seen: { word: 'Pregledana', tone: 'amber' },
  renotified: { word: 'Ponovo obaveštena', tone: 'amber' },
  approved: { word: 'Odobrena', tone: 'green' },
  rejected: { word: 'Odbijena', tone: 'red' },
  cancelled: { word: 'Otkazana', tone: 'grey' },
  storno: { word: 'Stornirana', tone: 'grey' },
  // Sales side (the pull stores Sent, Approved, Paid, OverDue, Archived).
  sent: { word: 'Poslata', tone: 'blue' },
  paid: { word: 'Plaćena', tone: 'green' },
  overdue: { word: 'Dospela', tone: 'red' },
  archived: { word: 'Arhivirana', tone: 'grey' },
  mistake: { word: 'Greška', tone: 'red' },
  draft: { word: 'Nacrt', tone: 'grey' },
  sending: { word: 'U slanju', tone: 'amber' },
}

const keyOf = (status: string | null | undefined): string => (status ?? '').trim().toLowerCase()

/** The word to show for a SEF status; an unknown value is shown as received; blank is null. */
export function sefStatusWord(status: string | null | undefined): string | null {
  const key = keyOf(status)
  if (!key) return null
  return WORDS[key]?.word ?? String(status).trim()
}

export function sefStatusTone(status: string | null | undefined): SefStatusTone {
  return WORDS[keyOf(status)]?.tone ?? 'neutral'
}
