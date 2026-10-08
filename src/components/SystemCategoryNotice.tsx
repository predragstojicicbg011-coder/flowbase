import React from 'react'
import {
  missingRoles, roleLabels, SETTINGS_PATH,
  type SystemCategoryMap, type SystemRole,
} from '../services/systemCategories'
import { plural } from '../utils/plural'

/** Where the settings tab lives. HashRouter, so a plain link works anywhere. */
export const SYSTEM_CATEGORIES_HREF = '#/settings?tab=system'

/**
 * A notice that the roles a page is about to post to are not set — shown
 * BEFORE anything is posted, so the user learns it here and not from a
 * refusal halfway through a month. Renders nothing when they all are, or
 * while the map is still loading.
 */
export default function SystemCategoryNotice({
  roles, map, loading, what, lead,
}: {
  roles: readonly SystemRole[]
  map: SystemCategoryMap
  loading?: boolean
  /** What cannot be posted, e.g. „Zarade“ or „Otplate kredita“. */
  what: string
  /** Replaces „{what} ne mogu da se proknjiže.“ for a page that only reads. */
  lead?: string
}) {
  if (loading) return null
  const missing = missingRoles(roles, map)
  if (missing.length === 0) return null
  return (
    <div role="alert" data-testid="system-category-notice" style={s.box}>
      <strong>{lead ?? `${what} ne mogu da se proknjiže.`}</strong>{' '}
      {plural(missing.length, 'Sistemska kategorija', 'Sistemske kategorije', 'Sistemskih kategorija')}{' '}
      {roleLabels(missing)}{' '}
      {plural(missing.length, 'nije podešena', 'nisu podešene', 'nije podešeno')}.{' '}
      Podesite {plural(missing.length, 'je', 'ih', 'ih')} u <a href={SYSTEM_CATEGORIES_HREF} style={s.link}>{SETTINGS_PATH}</a>.
    </div>
  )
}

const s = {
  box: {
    fontFamily: 'system-ui,sans-serif', fontSize: '12.5px', lineHeight: 1.5,
    background: '#FAEEDA', color: '#633806', border: '0.5px solid #E8C98F',
    borderRadius: '8px', padding: '10px 14px', margin: '0 0 12px',
  },
  link: { color: '#633806', fontWeight: 600 },
}
