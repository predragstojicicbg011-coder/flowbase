import React from 'react'
import { render, screen } from '@testing-library/react'
import DocumentTypeTag from './DocumentTypeTag'

describe('DocumentTypeTag', () => {
  it('says nothing on a bill', () => {
    const { container } = render(<DocumentTypeTag documentType="invoice" unlinked={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names a linked credit note', () => {
    render(<DocumentTypeTag documentType="credit_note" unlinked={false} />)
    expect(screen.getByText('Knjižno odobrenje')).toBeInTheDocument()
    expect(screen.queryByText('nije vezano')).not.toBeInTheDocument()
  })

  it('marks a note with no bill', () => {
    render(<DocumentTypeTag documentType="debit_note" unlinked />)
    expect(screen.getByText('Knjižno zaduženje')).toBeInTheDocument()
    expect(screen.getByText('nije vezano')).toBeInTheDocument()
  })
})
