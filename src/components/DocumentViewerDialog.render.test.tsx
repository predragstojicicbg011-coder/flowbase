import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import DocumentViewerDialog from './DocumentViewerDialog'

// A bill's PDF shown inside the app, over the list it was opened from.

const mockDocs: any = {}
jest.mock('../services/sef/invoiceDocuments', () => ({
  loadInvoiceDocuments: async () => mockDocs,
  UPLOAD_BUCKET: 'invoice-docs',
}))
jest.mock('../services/sef/sefPdf', () => ({
  sefObjectUrl: async (_c: any, path: string) => `https://files/${path}`,
  attachmentLabel: (a: any) => a.filename,
  SEF_PDF_URL_SECONDS: 60,
}))
jest.mock('../supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://uploads/${path}` } }) }) } },
}))

beforeEach(() => {
  Object.assign(mockDocs, {
    invoice: { id: 'i1' },
    linked: { pdf_path: 'sef/i1.pdf' },
    attachments: [{ id: 'a1', path: 'sef/otp.pdf', filename: 'Otpremnica' }],
    uploads: [{ id: 'u1', path: 'co/i1/u1.pdf', filename: 'ugovor.pdf', description: null }],
  })
})

describe('the document viewer', () => {
  it('shows the invoice first, and an attachment or an upload when chosen', async () => {
    render(<DocumentViewerDialog invoiceId="i1" title="Beton Plus · F-1" onClose={() => {}} />)
    expect(await screen.findByTitle('PDF dokument')).toHaveAttribute('src', 'https://files/sef/i1.pdf')
    fireEvent.click(screen.getByText('Otpremnica'))
    expect(await screen.findByTitle('PDF dokument')).toHaveAttribute('src', 'https://files/sef/otp.pdf')
    fireEvent.click(screen.getByText('ugovor.pdf'))
    expect(await screen.findByTitle('PDF dokument')).toHaveAttribute('src', 'https://uploads/co/i1/u1.pdf')
  })

  it('closes on its own, without closing the list under it', async () => {
    const onClose = jest.fn()
    const under = jest.fn()
    render(<div onClick={under}><DocumentViewerDialog invoiceId="i1" onClose={onClose} /></div>)
    await screen.findByTitle('PDF dokument')
    fireEvent.click(screen.getByLabelText('Pregled dokumenta').parentElement!)
    expect(onClose).toHaveBeenCalled()
    expect(under).not.toHaveBeenCalled()
  })

  it('says so when the bill has no PDF', async () => {
    Object.assign(mockDocs, { linked: null, attachments: [], uploads: [] })
    render(<DocumentViewerDialog invoiceId="i1" onClose={() => {}} />)
    expect(await screen.findByText('Za ovaj račun nema sačuvanog PDF-a.')).toBeInTheDocument()
  })
})
