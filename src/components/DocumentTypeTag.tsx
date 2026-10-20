import React from 'react'
import { DOCUMENT_TYPE_LABEL, type DocumentType } from '../services/documentType'

/**
 * Beside a document's number: which kind of document it is, where it is not a
 * plain bill, and a warning when a credit or debit note is not linked to its
 * bill yet. A bill shows nothing.
 */
export default function DocumentTypeTag({ documentType, unlinked, priorPeriod }: { documentType: DocumentType | null | undefined; unlinked: boolean | null | undefined; priorPeriod?: boolean | null }) {
  if (!documentType || documentType === 'invoice') return null
  const credit = documentType === 'credit_note'
  return (
    <span style={{ display: 'inline-flex', gap: '4px', marginLeft: '6px', verticalAlign: 'middle' }}>
      <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '20px', whiteSpace: 'nowrap', background: credit ? 'rgba(0,212,126,0.15)' : 'rgba(255,91,90,0.15)', color: credit ? '#00D47E' : '#FF5B5A' }}>
        {DOCUMENT_TYPE_LABEL[documentType]}
      </span>
      {priorPeriod && (
        <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '20px', whiteSpace: 'nowrap', background: 'rgba(122,155,184,0.15)', color: '#7A9BB8' }}>
          iz ranijeg perioda
        </span>
      )}
      {unlinked && (
        <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '20px', whiteSpace: 'nowrap', background: 'rgba(245,166,35,0.15)', color: '#F5A623' }}>
          nije vezano
        </span>
      )}
    </span>
  )
}
