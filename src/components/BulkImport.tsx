import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { useCompanies } from '../contexts/CompaniesContext'
import InlineCategoryAdd from './InlineCategoryAdd'
import * as XLSX from 'xlsx'
import {
  bookAmounts, getBookRates, partBookAmounts, partFromRsd, round2,
  type BookAmounts, type BookRates,
} from '../services/bookAmounts'
import { fmtMoney, fmtNum, fmtRSD } from '../utils/formatters'
import { importRowHash } from '../utils/importHash'
import PartnerDialog from './PartnerDialog'
import CreditInstallmentSelector from './CreditInstallmentSelector'
import { DIALOG } from './dialogTheme'
import SearchableSelect from './SearchableSelect'
import { REVENUE_STREAMS } from '../services/revenueStreams'
import { decodeStatement, hasLostCharacters } from '../services/decodeUpload'
import { differenceFor, entryNote, isBookable } from '../services/currencyDifference'
import {
  ADVANCE_BADGE_STYLE, ADVANCE_LABEL, doubleCountHint, effectiveAdvance, receiptShape, whyAdvanceNotSavable,
} from '../services/advanceReceipt'
import {
  describeMismatches, mismatches, type Expectation, type Settlement,
} from '../services/settlementCheck'
import {
  fetchScripts, saveScript, removeScript, orderedForDifference, findCurrencyDifference,
} from '../services/quickFillStore'
import { formatMoney, toOwn, toRsd } from '../services/allocationDisplay'
import { sameName } from '../services/lookupNames'
import SplitEditor from './SplitEditor'
import ProjectSelect from './ProjectSelect'
import { projectIdFromInput, projectIdToInput } from '../services/projects'
import {
  whySplitNotSavable, classificationFromSplit, splitProjectChange, type SplitLine,
} from '../services/expenseSplit'
import { saveSplits } from '../services/saveSplits'
import { linkAmountsFromOwn } from '../services/invoiceLinks'
import { outstandingOwn, settledStatus, settlementFor } from '../services/settleInvoice'
import {
  claimNotice, freeForRow, isHiddenForRow, type ClaimRow, type OpenInvoice,
} from '../services/invoiceClaims'
import { creditLegsFrom, creditNote, allocatePayment, type CreditLegs } from '../services/creditClassification'
import { CREDIT_ROLES } from '../services/systemCategories'
import { useSystemCategories } from '../contexts/SystemCategoriesContext'
import SystemCategoryNotice from './SystemCategoryNotice'
import { creditLegBooker, checkCreditCurrency, UnsupportedCreditCurrencyError } from '../services/creditPayment'
import { fetchAllPartners } from '../services/allPartners'
import { countOf } from '../utils/plural'

// credit payment P&L logic is inline

interface Props {
  onClose: () => void
  onImported: () => void
}

interface ParsedRow {
  id: string
  date: string
  statement_number: string
  currency: string
  debit: number | null
  credit: number | null
  partner_name: string
  description: string
  reference_number: string
  model: string
  account_number: string
  source_format: 'raiffeisen' | 'truist' | 'boa' | 'amex' | 'wio' | 'paypal'
  /**
   * Stabilan prirodni kljuc iz sadrzaja reda, kad izvor ima nesto sto
   * jednoznacno identifikuje stavku i ne mijenja se izmedju exporta.
   *
   * Bez ovoga se otisak racuna i iz REDNOG BROJA reda u fajlu, sto je tacno
   * za bankovni izvod (dvije iste provizije istog dana moraju obje proci),
   * ali pogresno za izvore gdje je svaki export nova lista sa novim redovima
   * na vrhu: ista stavka bi dobila drugi redni broj i bila uvezena ponovo.
   */
  natural_key?: string
}

interface AIProposal {
  tx_type: 'direct' | 'invoice_payment'
  tx_subtype: 'expense' | 'revenue' | null
  pl_category: string
  department: string
  expense_description: string
  revenue_stream: string
  partner_match: string | null
  confidence: 'high' | 'medium' | 'low'
  notes: string
}

type RowStatus = 'pending' | 'accepted' | 'rejected'

interface ImportRow {
  parsed: ParsedRow
  proposal: AIProposal | null
  status: RowStatus
  override_tx_type: 'direct' | 'invoice_payment' | 'passthrough' | 'credit_payment'
  override_tx_subtype: 'expense' | 'revenue'
  override_pt_direction: 'in' | 'out'
  override_pt_period: string
  override_payment_method: string
  override_linked_invoice_id: string
  override_linked_invoice_ids: string[]
  /** Book the leftover as a currency difference when this row is posted. */
  override_fx_book: boolean
  override_fx_script_id: string
  /**
   * The costs this one line is made of, where it is more than one.
   *
   * On the row, beside every other override, because that is what a row of
   * this table is: everything the import knows about one bank line. Empty
   * means a single expense, classified by the overrides below.
   */
  override_pl_splits: SplitLine[]
  override_pl_category_id: string
  override_pl_category_name: string
  override_pl_subcategory_id: string
  override_pl_subcategory_name: string
  override_department_id: string
  override_department_name: string
  override_dept_subcategory_id: string
  override_dept_subcategory_name: string
  override_expense_description: string
  override_revenue_stream: string
  /** The line's project: an id, or '' for company overhead. '' while split. */
  override_project_id: string
  override_cf_type: string
  override_cf_frequency: string
  override_cf_next_month_est: string
  override_partner_id: string
  override_partner_name: string
  override_note: string
  override_credit_id: string
  override_installment_ids: string[]
  /** An advance received (avans): kept only while the row is a direct revenue receipt. */
  override_is_advance: boolean
  /** Otisak reda, racunat pri parsiranju nad PUNOM listom. */
  import_hash: string
  /** Isti otisak vec postoji u bazi — red je uvezen ranije. */
  already_imported: boolean
}

const PAYMENT_METHODS = ['Wire transfer', 'ACH transfer', 'Cash', 'Check', 'Credit card', 'Direct debit', 'Other']
/** Display labels for the stored payment-method keys. */
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  'Wire transfer': 'Bankovni transfer', 'ACH transfer': 'ACH transfer', Cash: 'Gotovina', Check: 'Ček',
  'Credit card': 'Kreditna kartica', 'Direct debit': 'Direktno zaduženje', Other: 'Ostalo',
}

function detectFormat(content: string, fileName: string): 'raiffeisen' | 'truist' | 'boa' | 'amex' | 'wio' | 'paypal' | 'unknown' {
  if (fileName.toLowerCase().endsWith('.xlsx') || fileName.toLowerCase().endsWith('.xls')) return 'amex'
  const firstLine = content.replace(/^\uFEFF/, '').split('\n')[0] || ''
  if (firstLine.includes('Account name') && firstLine.includes('Account IBAN') && firstLine.includes('Transaction type')) return 'wio'
  if (firstLine.includes('Br. ra') || firstLine.includes('Datum obrade') || firstLine.startsWith('265-') || firstLine.startsWith('160-') || firstLine.startsWith('170-')) return 'raiffeisen'
  if (firstLine.includes('Posted Date') && firstLine.includes('Transaction Date') && firstLine.includes('Merchant name')) return 'truist'
  if (firstLine.includes('Description') && firstLine.includes('Summary Amt')) return 'boa'
  if (firstLine.includes('Transaction ID') && firstLine.includes('Balance Impact') && firstLine.includes('From Email Address')) return 'paypal'
  return 'unknown'
}

function parseRaiffeisen(content: string): ParsedRow[] {
  const lines = content.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const rows: ParsedRow[] = []
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return
    const cols = line.split('#')
    if (cols.length < 13) return
    const parseAmt = (s: string): number | null => {
      if (!s || !s.trim()) return null
      const v = parseFloat(s.trim().replace(/\./g, '').replace(',', '.'))
      return isNaN(v) ? null : v
    }
    const debit = parseAmt(cols[5])
    const credit = parseAmt(cols[6])
    if (debit === null && credit === null) return
    rows.push({
      id: `row_${index}`, source_format: 'raiffeisen',
      date: cols[1]?.trim() || '',
      statement_number: cols[2]?.trim() || '',
      currency: cols[3]?.trim() || 'RSD',
      debit, credit,
      partner_name: (cols[11] || '').replace(/[\r\n]/g, '').trim() || '',
      description: (cols[12] || cols[8] || '').replace(/[\r\n]/g, '').trim() || '',
      reference_number: cols[15]?.trim() || cols[14]?.trim() || '',
      model: cols[17]?.trim() || cols[16]?.trim() || '',
      account_number: (cols[10] || '').replace(/[\r\n\t]/g, '').trim() || '',
    })
  })
  return rows
}

function parseTruist(content: string): ParsedRow[] {
  const lines = content.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const rows: ParsedRow[] = []
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []; let current = ''; let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes }
      else if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = '' }
      else { current += line[i] }
    }
    result.push(current.trim()); return result
  }
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return
    const cols = parseCSVLine(line)
    if (cols.length < 9) return
    let amountStr = cols[8]?.replace(/[,$]/g, '').trim() || '0'
    if (amountStr.startsWith('(') && amountStr.endsWith(')')) amountStr = '-' + amountStr.slice(1, -1)
    const rawAmount = parseFloat(amountStr) || 0
    if (rawAmount === 0) return
    const isExpense = rawAmount < 0
    const absAmount = Math.abs(rawAmount)
    const debit = isExpense ? absAmount : null
    const credit = isExpense ? null : absAmount
    const rawDate = cols[1]?.trim() || cols[0]?.trim() || ''
    const dateParts = rawDate.split('/')
    const date = dateParts.length === 3 ? `${dateParts[1]}.${dateParts[0]}.${dateParts[2]}` : rawDate
    rows.push({ id: `row_${index}`, source_format: 'truist', date, statement_number: '', currency: 'USD', debit, credit, partner_name: cols[5]?.trim() || '', description: cols[4]?.trim() || '', reference_number: cols[3]?.trim() || '', model: '', account_number: '' })
  })
  return rows
}

function parseBOA(content: string): ParsedRow[] {
  const lines = content.split('\n').filter(l => l.trim())
  const rows: ParsedRow[] = []
  let dataStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Date,') && lines[i].includes('Description') && lines[i].includes('Amount')) { dataStart = i + 1; break }
  }
  if (dataStart === 0) return []
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []; let current = ''; let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes }
      else if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = '' }
      else { current += line[i] }
    }
    result.push(current.trim()); return result
  }
  lines.slice(dataStart).forEach((line, index) => {
    if (!line.trim()) return
    const cols = parseCSVLine(line)
    if (cols.length < 3) return
    const rawDate = cols[0]?.trim() || ''
    const description = cols[1]?.trim() || ''
    const rawAmount = parseFloat(cols[2]?.replace(/[,$]/g, '') || '0') || 0
    if (rawAmount === 0) return
    if (description.toLowerCase().includes('beginning balance') || description.toLowerCase().includes('ending balance')) return
    const debit = rawAmount < 0 ? Math.abs(rawAmount) : null
    const credit = rawAmount > 0 ? rawAmount : null
    const dateParts = rawDate.split('/')
    const date = dateParts.length === 3 ? `${dateParts[1]}.${dateParts[0]}.${dateParts[2]}` : rawDate
    let partnerName = description
    if (description.includes('WIRE TYPE:')) { const bnfMatch = description.match(/BNF:([^I]+?)(?:\s+ID:|$)/); if (bnfMatch) partnerName = bnfMatch[1].trim() }
    else if (description.includes(' DES:')) { partnerName = description.split(' DES:')[0].trim() }
    rows.push({ id: `row_${index}`, source_format: 'boa', date, statement_number: '', currency: 'USD', debit, credit, partner_name: partnerName.slice(0, 60), description: description.slice(0, 200), reference_number: '', model: '', account_number: '' })
  })
  return rows
}

function parseAmex(workbook: XLSX.WorkBook): ParsedRow[] {
  const ws = workbook.Sheets[workbook.SheetNames[0]]
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  const rows: ParsedRow[] = []
  let headerRow = -1
  for (let i = 0; i < data.length; i++) {
    const row = data[i]
    if (row[0] === 'Date' && row[2] === 'Description' && row[3] === 'Amount') { headerRow = i; break }
  }
  if (headerRow === -1) return []
  data.slice(headerRow + 1).forEach((row, index) => {
    if (!row[0] || !row[3]) return
    const rawAmount = typeof row[3] === 'number' ? row[3] : parseFloat(String(row[3]).replace(/[,$]/g, '') || '0')
    if (isNaN(rawAmount) || rawAmount === 0) return
    const isPayment = String(row[2] || '').toLowerCase().includes('payment') && rawAmount < 0
    if (isPayment) return
    const debit = rawAmount > 0 ? rawAmount : null
    const credit = rawAmount < 0 ? Math.abs(rawAmount) : null
    const rawDate = String(row[0] || '')
    const dateParts = rawDate.split('/')
    const date = dateParts.length === 3 ? `${dateParts[1]}.${dateParts[0]}.${dateParts[2]}` : rawDate
    const description = String(row[2] || '').trim()
    const category = String(row[11] || '').trim()
    const city = String(row[7] || '').trim()
    let partnerName = description.split(/\s{2,}/)[0].trim()
    if (city) partnerName = partnerName.replace(city, '').trim()
    rows.push({ id: `row_${index}`, source_format: 'amex', date, statement_number: String(row[10] || ''), currency: 'USD', debit, credit, partner_name: partnerName.slice(0, 60), description: `${description}${category ? ` [${category}]` : ''}`, reference_number: String(row[10] || ''), model: '', account_number: '' })
  })
  return rows
}

function parsePayPal(content: string): ParsedRow[] {
  const lines = content.split('\n')
  if (lines.length < 2) return []
  const parseCSVLinePP = (line: string): string[] => {
    const result: string[] = []; let current = ''; let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes }
      else if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = '' }
      else { current += line[i] }
    }
    result.push(current.trim()); return result
  }
  const headerLine = lines[0].replace(/^\uFEFF/, '')
  const headerCols = parseCSVLinePP(headerLine)
  const col = (name: string) => headerCols.findIndex(h => h.trim() === name)
  const iDate = col('Date'), iName = col('Name'), iType = col('Type')
  const iStatus = col('Status'), iCurrency = col('Currency')
  const iGross = col('Gross'), iFee = col('Fee'), iNet = col('Net')
  const iTxId = col('Transaction ID'), iRefTxId = col('Reference Txn ID')
  const iInvoiceNum = col('Invoice Number'), iSubject = col('Subject')
  const iNote = col('Note'), iBalanceImpact = col('Balance Impact')
  const INCLUDE_TYPES = new Set(['User Initiated Withdrawal', 'Mass Pay Payment', 'Mass Pay Reversal', 'General Payment', 'Subscription Payment', 'Bank Deposit to PP Account'])
  const parseAmt = (s: string): number => { if (!s) return 0; return parseFloat(s.replace(/[",]/g, '').trim()) || 0 }
  const rows: ParsedRow[] = []
  let rowIndex = 0
  lines.slice(1).forEach(line => {
    if (!line.trim()) return
    const cols = parseCSVLinePP(line.replace(/\r/g, ''))
    if (cols.length < 10) return
    const txType = cols[iType]?.trim() || ''
    if (!INCLUDE_TYPES.has(txType)) return
    const status = cols[iStatus]?.trim() || ''
    const allowedStatuses = new Set(['Completed', 'Removed', 'Pending'])
    if (!allowedStatuses.has(status)) return
    const rawDate = cols[iDate]?.trim() || ''
    const dateParts = rawDate.split('/')
    const date = dateParts.length === 3 ? `${dateParts[2]}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}` : rawDate
    const currency = cols[iCurrency]?.trim() || 'USD'
    const gross = parseAmt(cols[iGross]); const fee = parseAmt(cols[iFee]); const net = parseAmt(cols[iNet])
    const name = cols[iName]?.trim() || ''
    const txId = cols[iTxId]?.trim() || ''; const refTxId = cols[iRefTxId]?.trim() || ''
    const invoiceNum = cols[iInvoiceNum]?.trim() || ''; const subject = cols[iSubject]?.trim() || ''
    const note = cols[iNote]?.trim() || ''; const balanceImpact = cols[iBalanceImpact]?.trim() || ''
    const isCredit = balanceImpact === 'Credit'
    const descParts = [subject, note, invoiceNum ? `Invoice: ${invoiceNum}` : '', refTxId ? `Ref: ${refTxId}` : ''].filter(Boolean)
    const description = descParts.join(' | ')
    const makeRow = (debit: number | null, credit: number | null, partner: string, desc: string, ref: string, txHint?: string): ParsedRow => ({
      id: `paypal_${rowIndex++}`, source_format: 'paypal' as any, date, statement_number: txHint || '', currency, debit, credit, partner_name: partner, description: desc, reference_number: ref, model: txHint || '', account_number: '',
    })
    if (txType === 'User Initiated Withdrawal') {
      const absGross = Math.abs(gross); const absFee = Math.abs(fee)
      if (absFee > 0) { rows.push(makeRow(absGross, null, 'PayPal', `Instant withdrawal${description ? ' | ' + description : ''} | TX: ${txId}`, txId, 'passthrough')); rows.push(makeRow(absFee, null, 'PayPal', `Instant withdrawal fee | TX: ${txId}`, txId, 'expense')) }
      else { rows.push(makeRow(Math.abs(net), null, 'PayPal', `Withdrawal${description ? ' | ' + description : ''} | TX: ${txId}`, txId, 'passthrough')) }
      return
    }
    if (txType === 'General Payment' && isCredit) { rows.push(makeRow(null, Math.abs(net), name || 'PayPal customer', `PayPal payment received${description ? ' | ' + description : ''} | TX: ${txId}`, invoiceNum || txId)); return }
    if (txType === 'Mass Pay Payment') { const absGross = Math.abs(gross); const absFee = Math.abs(fee); rows.push(makeRow(absGross, null, name || 'PayPal', `Mass Pay Payment${description ? ' | ' + description : ''} | TX: ${txId}`, refTxId || txId)); if (absFee > 0) { rows.push(makeRow(absFee, null, 'PayPal', `Mass Pay Fee${description ? ' | ' + description : ''} | TX: ${txId}`, refTxId || txId)) } return }
    if (txType === 'Mass Pay Reversal') { rows.push(makeRow(null, Math.abs(net), name || 'PayPal', `⚠️ Mass Pay Reversal${description ? ' | ' + description : ''} | TX: ${txId}`, refTxId || txId)); return }
    if (txType === 'Bank Deposit to PP Account') { rows.push(makeRow(null, Math.abs(net), 'PayPal', `Bank deposit to PayPal${description ? ' | ' + description : ''} | TX: ${txId}`, txId, 'passthrough')); return }
    rows.push(makeRow(Math.abs(net), null, name || 'PayPal', `${txType}${description ? ' | ' + description : ''} | TX: ${txId}`, refTxId || txId))
  })
  return rows
}

function parseWio(content: string): ParsedRow[] {
  const lines = content.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []; let current = ''; let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes }
      else if (line[i] === ',' && !inQuotes) { result.push(current.trim()); current = '' }
      else { current += line[i] }
    }
    result.push(current.trim()); return result
  }
  const rows: ParsedRow[] = []
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return
    const cols = parseCSVLine(line.replace(/\r/g, ''))
    if (cols.length < 11) return
    const currency = cols[5]?.trim() || 'RSD'; const txType = cols[6]?.trim() || ''
    const rawDate = cols[7]?.trim() || ''; const refNum = cols[8]?.trim() || ''
    const description = cols[9]?.trim() || ''
    const rawAmount = parseFloat(cols[10]?.replace(/,/g, '') || '0') || 0
    const notes = cols[13]?.trim() || ''
    if (rawAmount === 0) return; if (txType === 'Currency exchange') return
    const dateParts = rawDate.split('/')
    const date = dateParts.length === 3 ? `${dateParts[0]}.${dateParts[1]}.${dateParts[2]}` : rawDate
    const debit = rawAmount < 0 ? Math.abs(rawAmount) : null
    const credit = rawAmount > 0 ? rawAmount : null
    let partnerName = description
    if (description.toLowerCase().startsWith('to ')) partnerName = description.slice(3)
    else if (description.toLowerCase().startsWith('from ')) partnerName = description.slice(5)
    const fullDesc = notes && notes !== 'N/A' && notes !== description ? `${description} — ${notes}` : description
    rows.push({ id: `row_${index}`, source_format: 'wio' as any, date, statement_number: refNum, currency, debit, credit, partner_name: partnerName.slice(0, 80), description: fullDesc.slice(0, 200), reference_number: refNum, model: '', account_number: cols[3]?.trim() || '' })
  })
  return rows
}

function formatDate(d: string): string {
  if (!d) return ''
  const parts = d.split('.')
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`
  return d
}

/**
 * A row's four stored columns, as the analysis step attached them, or null.
 * Read from `parsed` because that is where `analyzeWithAI` puts them.
 */
function attachedBook(p: any): BookAmounts | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const ex = n(p?.exchange_rate), eur = n(p?.eur_rate), rsd = n(p?.amount_rsd), e = n(p?.amount_eur)
  return ex !== null && eur !== null && rsd !== null && e !== null
    ? { exchange_rate: ex, eur_rate: eur, amount_rsd: rsd, amount_eur: e }
    : null
}

/**
 * Books amounts at the NBS rates for a date, fetching each date once.
 * Throws RateUnavailableError — never a guessed rate.
 */
function makeBooker() {
  const cache: Record<string, Promise<BookRates>> = {}
  return async (amount: number, currency: string, isoDate: string): Promise<BookAmounts> => {
    if (!cache[isoDate]) cache[isoDate] = getBookRates(isoDate)
    let rates: BookRates
    try {
      rates = await cache[isoDate]
    } catch (err) {
      delete cache[isoDate]
      throw err
    }
    return bookAmounts(amount, currency, rates)
  }
}

function makeImportRow(parsed: ParsedRow): ImportRow {
  const isExpense = (parsed.debit || 0) > 0
  const isPassthrough = parsed.statement_number === 'passthrough'
  const txType = isPassthrough ? 'passthrough' : 'direct'
  const ptDirection = isExpense ? 'out' : 'in'
  return {
    parsed, proposal: null, status: 'pending',
    override_tx_type: txType,
    override_tx_subtype: isExpense ? 'expense' : 'revenue',
    override_pt_direction: ptDirection,
    override_pt_period: new Date().toISOString().slice(0, 7),
    override_payment_method: 'Wire transfer',
    override_linked_invoice_id: '',
    override_linked_invoice_ids: [], override_fx_book: false, override_fx_script_id: '',
    override_pl_splits: [],
    override_pl_category_id: '', override_pl_category_name: '',
    override_pl_subcategory_id: '', override_pl_subcategory_name: '',
    override_department_id: '', override_department_name: '',
    override_dept_subcategory_id: '', override_dept_subcategory_name: '',
    override_expense_description: '', override_revenue_stream: '',
    override_project_id: '',
    override_cf_type: '',
    override_cf_frequency: 'monthly',
    override_cf_next_month_est: '',
    override_partner_id: '', override_partner_name: parsed.partner_name,
    override_note: '',
    override_credit_id: '',
    override_installment_ids: [],
    override_is_advance: false,
    import_hash: '',
    already_imported: false,
  }
}

const FORMAT_LABELS: Record<string, string> = {
  raiffeisen: '🇷🇸 Raiffeisen/Intesa/Halkbank', truist: '🇺🇸 Truist', boa: '🇺🇸 Bank of America',
  amex: '💳 American Express', wio: '🇦🇪 Wio Bank', paypal: '🅿️ PayPal',
}

export default function BulkImport({ onClose, onImported }: Props) {
  const [step, setStep] = useState<'upload' | 'review' | 'posting' | 'done'>('upload')
  const [rows, setRows] = useState<ImportRow[]>([])
  const [detectedFormat, setDetectedFormat] = useState<string>('')
  /** Set when the file was not UTF-8, so the import can say what it read. */
  const [encodingNote, setEncodingNote] = useState<string>('')
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [analyzeError, setAnalyzeError] = useState('')
  const { companies, defaultCompany, showPicker } = useCompanies()
  /** Where a credit instalment's two legs post — see services/systemCategories. */
  const systemCategories = useSystemCategories()
  const [company, setCompany] = useState('')

  // One company: it is the company, and nobody is asked to choose it.
  useEffect(() => {
    if (!showPicker && defaultCompany) setCompany(prev => prev || defaultCompany.id)
  }, [showPicker, defaultCompany])
  const [bank, setBank] = useState('')
  const [banks, setBanks] = useState<any[]>([])
  const [allBanks, setAllBanks] = useState<any[]>([])
  const [partners, setPartners] = useState<any[]>([])
  const [openInvoices, setOpenInvoices] = useState<any[]>([])
  const [invoiceSearch, setInvoiceSearch] = useState<Record<string, string>>({})
  const [invoicePickerOpen, setInvoicePickerOpen] = useState<Record<string, boolean>>({})
  /**
   * Per row: whether the picker still lists invoices another line has taken.
   *
   * OUT OF THE LIST, not greyed in it. Greying one of two identical invoices
   * is a distinction nobody makes at a glance, and this list is most often
   * long precisely when the invoices repeat — six identical open bills and
   * six identical payments, which is exactly the case where closing the same
   * one twice leaves another outstanding and reconciles to the penny.
   *
   * A toggle rather than a hard filter: what is hidden is still said, and
   * still reachable, because a claim made on another line may itself be the
   * mistake being looked for.
   */
  const [showTaken, setShowTaken] = useState<Record<string, boolean>>({})
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  /** Set when the database does not agree with what the import promised. */
  const [settlementWarning, setSettlementWarning] = useState('')
  const [importHistory, setImportHistory] = useState<any[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [reviewPartnerSearch, setReviewPartnerSearch] = useState<Record<string, string>>({})
  const [savingAccount, setSavingAccount] = useState<Record<string, boolean>>({})
  const [partnerDialogRow, setPartnerDialogRow] = useState<{ rowId: string; initialName: string; initialAccount: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [plCategories, setPlCategories] = useState<any[]>([])
  const [plSubcategories, setPlSubcategories] = useState<any[]>([])
  const [departments, setDepartments] = useState<any[]>([])
  const [deptSubcategories, setDeptSubcategories] = useState<any[]>([])
  const [expenseDescriptions, setExpenseDescriptions] = useState<any[]>([])
  const [partnerAccounts, setPartnerAccounts] = useState<any[]>([])
  const [credits, setCredits] = useState<any[]>([])
  const [bulkInstallments, setBulkInstallments] = useState<Record<string, any[]>>({})

  // ── Quick Fill Scripts ────────────────────────────────────────────────────
  interface QuickFillScript {
    id: string
    name: string
    icon: string
    pl_category: string
    pl_subcategory: string
    department: string
    dept_subcategory: string
    expense_description: string
    cf_type: string
  }
  // The starter set that used to live here is gone with the localStorage
  // fallback. An empty list now means nobody has made a template, and filling
  // one in from a hardcoded guess would classify real money under categories
  // nobody chose. `src/data/quickfill.ts` still holds the same set if it is
  // ever worth offering from the Settings tab as a starting point.
  // Shared, in the table — see 20260922140000. `DEFAULT_SCRIPTS` is no longer
  // a fallback: an empty list means nobody has made any, and inventing some
  // would classify real money under categories nobody chose.
  const [quickFillScripts, setQuickFillScripts] = useState<QuickFillScript[]>([])
  const refreshScripts = useCallback(async () => {
    setQuickFillScripts(await fetchScripts(supabase) as QuickFillScript[])
  }, [])
  useEffect(() => { refreshScripts() }, [refreshScripts])

  const persistScript = async (draft: QuickFillScript) => {
    const { ok, message } = await saveScript(supabase, draft as any)
    if (!ok) { window.alert(message); return false }
    await refreshScripts()
    return true
  }

  const removeScriptById = async (id: string) => {
    const { ok, message } = await removeScript(supabase, id)
    if (!ok) { window.alert(message); return }
    await refreshScripts()
  }
  const [qfDialogOpen, setQfDialogOpen] = useState(false)
  const [qfEditing, setQfEditing] = useState<QuickFillScript | null>(null)
  const [qfSearch, setQfSearch] = useState('')
  const [qfOpen, setQfOpen] = useState<string | null>(null)
  const EMPTY_SCRIPT: QuickFillScript = { id: '', name: '', icon: '⚡', pl_category: '', pl_subcategory: '', department: '', dept_subcategory: '', expense_description: '', cf_type: 'recurring' }

  useEffect(() => {
    const load = async () => {
      const [
        { data: bnk }, part,
        { data: plCat }, { data: plSub }, { data: dept },
        { data: deptSub }, { data: expDesc }, { data: pacc },
      ] = await Promise.all([
        supabase.from('banks').select('*').order('name'),
        fetchAllPartners(supabase),
        supabase.from('pl_categories').select('id,name,sort_order').order('sort_order'),
        supabase.from('pl_subcategories').select('id,name,category_id,sort_order').order('sort_order'),
        supabase.from('departments').select('id,name,sort_order').order('sort_order'),
        supabase.from('dept_subcategories').select('id,name,department_id,sort_order').order('sort_order'),
        supabase.from('expense_descriptions').select('id,name,dept_subcategory_id,sort_order').order('sort_order'),
        supabase.from('partner_accounts').select('id,partner_id,account_number,bank_name,is_primary').order('is_primary', { ascending: false }).range(0, 999),
      ])
      if (bnk) setAllBanks(bnk)
      if (part) setPartners(part)
      if (plCat) setPlCategories(plCat)
      if (plSub) setPlSubcategories(plSub)
      if (dept) setDepartments(dept)
      if (deptSub) setDeptSubcategories(deptSub)
      if (expDesc) setExpenseDescriptions(expDesc)
      if (pacc) setPartnerAccounts(pacc)
      const { data: creds } = await supabase
        .from('credits').select('id,name,bank,rate_description,currency')
        .eq('status', 'active').order('name')
      // A credit's figures are in its own currency; a missing one reads as
      // RSD, as in useCreditPayment.
      if (creds) setCredits(creds.map((c: any) => ({ ...c, currency: c.currency || 'RSD' })))
    }
    load()
  }, [])

  useEffect(() => {
    if (company) setBanks(allBanks.filter(b => b.company_id === company))
  }, [company, allBanks])

  useEffect(() => {
    if (!company || !bank) { setImportHistory([]); return }
    const fetchHistory = async () => {
      const { data, error } = await supabase
        .from('import_logs')
        .select('*')
        .eq('company_id', company)
        .eq('bank_id', bank)
        .eq('import_type', 'bank_statement')
        .order('date_from', { ascending: false })
        .limit(50)
      if (error) console.error('import_logs error:', error)
      setImportHistory(data || [])
      if (data && data.length > 0) setHistoryExpanded(true)
    }
    fetchHistory()
  }, [company, bank])

  useEffect(() => {
    if (!company) return
    const fetchInvoices = async () => {
      const { data, error } = await supabase.from('v_invoice_status').select('*').eq('company_id', company)
        .in('calculated_status', ['unpaid', 'partial']).order('due_date', { ascending: true })
      if (error) console.warn('v_invoice_status error (non-critical):', error.message)
      if (data) setOpenInvoices(data)
    }
    fetchInvoices()
  }, [company])

  /**
   * The leftover on a row that closes exactly one invoice.
   *
   * Only one: with several, which of them the difference belongs to is a
   * judgement rather than arithmetic, and the allocation loop below spreads a
   * payment across them in order — so there is no single invoice to attribute
   * a shortfall to. See services/currencyDifference.ts.
   */
  const fxForRow = useCallback((row: ImportRow) => {
    if (row.override_tx_type !== 'invoice_payment') return null
    const ids = row.override_linked_invoice_ids?.length > 0
      ? row.override_linked_invoice_ids
      : row.override_linked_invoice_id ? [row.override_linked_invoice_id] : []
    if (ids.length !== 1) return null
    const inv = openInvoices.find(i => i.id === ids[0])
    if (!inv) return null

    const p = row.parsed
    const own = (p.debit || 0) > 0 ? (p.debit || 0) : (p.credit || 0)
    if (own <= 0) return null
    // In RSD, the book currency both sides share: the row at its own rate
    // (attached by the analysis step; a dinar row needs none), the invoice's
    // remainder at the invoice's.
    const booked = attachedBook(p)
    const rowRsd = booked ? booked.amount_rsd : p.currency === 'RSD' ? own : 0
    if (rowRsd <= 0) return null

    const remainingRsd = toRsd(outstandingOwn(inv), inv)
    const allocRsd = Math.min(rowRsd, remainingRsd)
    const difference = differenceFor({
      invoiceShortfall: remainingRsd - allocRsd,
      paymentUnallocated: rowRsd - allocRsd,
      currency: 'RSD',
      invoiceType: inv.type ?? null,
    })
    return {
      inv,
      difference,
      // The linked side (the rest of the bill) is in the invoice's currency.
      amountOwn: difference.linksToInvoice
        ? toOwn(difference.amount, inv)
        // A loss is part of this bank line, in the line's currency at its rate.
        : booked
          ? partFromRsd(difference.amount, { currency: p.currency, exchange_rate: booked.exchange_rate, eur_rate: booked.eur_rate }).amount
          : difference.amount,
      currency: difference.linksToInvoice ? (inv.currency || p.currency) : p.currency,
    }
  }, [openInvoices])

  const fxScripts = useMemo(() => orderedForDifference(quickFillScripts), [quickFillScripts])

  const getPlSubs = (catId: string) => plSubcategories.filter(s => s.category_id === catId)
  const getDeptSubs = (deptId: string) => deptSubcategories.filter(s => s.department_id === deptId)
  const getExpDescs = (subId: string) => expenseDescriptions.filter(e => e.dept_subcategory_id === subId)

  // Normalize Serbian bank account numbers for comparison.
  // Handles NBS format (160-123456-78) and izvod format (160-000000012345678).
  const normalizeAccountNumber = (acc: string): string => {
    if (!acc) return ''
    const a = acc.replace(/[\r\n\t]/g, '').trim().replace(/\s/g, '')
    const parts = a.split('-')
    if (parts.length === 3) {
      const bank = parts[0].replace(/^0+/, '') || '0'
      const core = parts[1].replace(/^0+/, '') || '0'
      const ctrl = parts[2].replace(/^0+/, '') || '0'
      return `${bank}|${core}|${ctrl}`
    } else if (parts.length === 2) {
      const bank = parts[0].replace(/^0+/, '') || '0'
      const full = parts[1]
      if (full.length >= 3) {
        const core = full.slice(0, -2).replace(/^0+/, '') || '0'
        const ctrl = full.slice(-2).replace(/^0+/, '') || '0'
        return `${bank}|${core}|${ctrl}`
      }
      return `${bank}|${full.replace(/^0+/, '') || '0'}`
    }
    return a.replace(/\D/g, '').replace(/^0+/, '') || '0'
  }

  const matchPartnerByAccount = (accountNum: string, pacc: any[], partList: any[]): { name: string; id: string } | null => {
    if (!accountNum) return null
    const cleanNum = accountNum.replace(/[\r\n\t]/g, '').trim()
    if (!cleanNum) return null
    const normalizedInput = normalizeAccountNumber(cleanNum)
    if (!normalizedInput) return null
    const match = pacc.find((pa: any) => {
      const normalizedDB = normalizeAccountNumber(pa.account_number || '')
      return normalizedDB && normalizedDB === normalizedInput
    })
    if (!match) return null
    const partner = partList.find((p: any) => p.id === match.partner_id)
    if (!partner) return null
    return { name: partner.name, id: partner.id }
  }

  const openPartnerDialog = (rowId: string, name: string, accountNumber: string) => {
    setPartnerDialogRow({ rowId, initialName: name, initialAccount: accountNumber })
  }

  const saveAccountToPartner = async (rowId: string, partnerId: string, accountNumber: string) => {
    if (!partnerId || !accountNumber.trim()) return
    setSavingAccount(prev => ({ ...prev, [rowId]: true }))
    const { data: newAcc, error } = await supabase.from('partner_accounts').insert({
      partner_id: partnerId,
      account_number: accountNumber.trim(),
      currency: 'RSD',
      is_primary: false,
    }).select('id,partner_id,account_number,bank_name,is_primary').single()
    if (error) {
      console.error('saveAccount error:', error)
      alert(`Račun nije sačuvan: ${error.message}`)
    } else if (newAcc) {
      setPartnerAccounts(prev => [...prev, newAcc])
    }
    setSavingAccount(prev => ({ ...prev, [rowId]: false }))
  }

  /**
   * Racuna otisak svakog reda i provjerava koji vec postoje u bazi.
   *
   * Radi se PRIJE ekrana za pregled. Ranije je provjera postojala samo pri
   * knjizenju, pa je ponovni uvoz istog fajla nudio sve redove kao nove i tek
   * poslije "Post" javljao da je sve preskoceno.
   *
   * Otisak se racuna nad PUNOM listom redova, ne nad prihvacenima — inace bi
   * odbacivanje jednog reda pomjerilo indekse ostalima i promijenilo im otiske,
   * pa bi ponovni uvoz istog fajla prosao kao nov.
   */
  const markAlreadyImported = async (importRows: ImportRow[]): Promise<ImportRow[]> => {
    if (!company || !bank || importRows.length === 0) return importRows

    const withHash = await Promise.all(importRows.map(async (r, index) => {
      const p = r.parsed
      const hash = p.natural_key
        ? await importRowHash([company, bank, p.natural_key])
        : await importRowHash([
            company, bank, p.statement_number, index,
            formatDate(p.date), p.debit, p.credit, p.currency,
            p.description, p.reference_number, p.account_number,
          ])
      return { ...r, import_hash: hash }
    }))

    // Provjera ide u komadima: 1.655 otisaka u jednom `in.()` filteru bi
    // napravilo URL od preko 100 kB.
    const existing = new Set<string>()
    const CHUNK = 100
    const hashes = withHash.map(r => r.import_hash)
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const slice = hashes.slice(i, i + CHUNK)
      const [tx, pt] = await Promise.all([
        supabase.from('transactions').select('import_hash').in('import_hash', slice),
        supabase.from('passthrough').select('import_hash').in('import_hash', slice),
      ])
      for (const res of [tx, pt]) {
        (res.data || []).forEach((r: any) => { if (r.import_hash) existing.add(r.import_hash) })
      }
    }

    return withHash.map(r => existing.has(r.import_hash)
      ? { ...r, already_imported: true, status: 'rejected' as RowStatus }
      : r)
  }

  const handleFile = async (file: File) => {
    setParseError('')
    setFileName(file.name)
    setDetectedFormat('')

    // Always fetch fresh data from DB before matching
    const fetchFreshData = async () => {
      // Paginate partner_accounts (Supabase max 1000/page)
      let allAccounts: any[] = []
      let from = 0
      const pageSize = 1000
      while (true) {
        const { data: page, error } = await supabase
          .from('partner_accounts')
          .select('id,partner_id,account_number,bank_name,is_primary')
          .range(from, from + pageSize - 1)
        if (error || !page || page.length === 0) break
        allAccounts = [...allAccounts, ...page]
        if (page.length < pageSize) break
        from += pageSize
      }

      // `.range(0, 9999)` looked like it asked for ten thousand and did not:
      // the server caps a response at a thousand rows whatever the range
      // says, so this read the first thousand and reported no truncation.
      const freshPartners = await fetchAllPartners<{ id: string; name: string }>(
        supabase, 'id,name')

      if (allAccounts.length > 0) setPartnerAccounts(allAccounts)
      if (freshPartners.length > 0) setPartners(freshPartners as any)

      return { accList: allAccounts.length > 0 ? allAccounts : partnerAccounts, partList: freshPartners.length > 0 ? freshPartners : partners }
    }

    try {
      if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
        const buffer = await file.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const parsed = parseAmex(workbook)
        setEncodingNote('')   // a workbook carries its own encoding
        if (parsed.length === 0) { setParseError('Fajl Amex nije mogao da se pročita.'); return }
        setDetectedFormat('amex')
        const { accList, partList } = await fetchFreshData()
        const importRows = await markAlreadyImported(parsed.map(makeImportRow))
        setRows(importRows.map(r => {
          const matched = matchPartnerByAccount(r.parsed.account_number, accList, partList)
          if (matched) console.log(`✓ Match: ${r.parsed.account_number} → ${matched.name}`)
          return matched ? { ...r, override_partner_name: matched.name, override_partner_id: matched.id } : r
        }))
      } else {
        // `file.text()` always decodes as UTF-8, and the domestic statements
        // are windows-1250 — where `Ć` is a single byte that UTF-8 rejects and
        // replaces, turning POVRAĆAJ POZAJMICE into POVRA<?>AJ with the letter
        // gone for good. So the encoding is decided before the decode.
        const decoded = decodeStatement(await file.arrayBuffer())
        const text = decoded.text
        setEncodingNote(
          hasLostCharacters(text)
            ? 'Neki znakovi u ovom fajlu nisu mogli da se pročitaju i zamenjeni su. Proverite opise pre knjiženja.'
            : decoded.fellBack ? 'Pročitano kao windows-1250' : '')
        const format = detectFormat(text, file.name)
        if (format === 'unknown') { setParseError('Nepoznat format fajla.'); return }
        setDetectedFormat(format)
        let parsed: ParsedRow[] = []
        if (format === 'raiffeisen') parsed = parseRaiffeisen(text)
        else if (format === 'truist') parsed = parseTruist(text)
        else if (format === 'boa') parsed = parseBOA(text)
        else if (format === 'wio') parsed = parseWio(text)
        else if (format === 'paypal') parsed = parsePayPal(text)
        if (parsed.length === 0) { setParseError('U fajlu nema transakcija.'); return }
        const { accList, partList } = await fetchFreshData()
        const importRows = await markAlreadyImported(parsed.map(makeImportRow))
        setRows(importRows.map(r => {
          const matched = matchPartnerByAccount(r.parsed.account_number, accList, partList)
          return matched ? { ...r, override_partner_name: matched.name, override_partner_id: matched.id } : r
        }))
      }
    } catch (err: any) {
      setParseError(`Fajl nije pročitan: ${err.message}`)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const analyzeWithAI = async () => {
    if (!company || !bank) return
    setAnalyzing(true); setAnalyzeError(''); setProgress(0)
    const supabaseUrl = process.env.REACT_APP_SUPABASE_URL
    const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY
    // Every row's book columns at the NBS rates for its date — an RSD row too,
    // which still needs the EUR rate for amount_eur.
    const bookRow = makeBooker()
    let rowsWithRates: typeof rows
    try {
    rowsWithRates = await Promise.all(rows.map(async (row) => {
      const { currency, date, debit, credit } = row.parsed
      const amount = (debit || 0) > 0 ? (debit || 0) : (credit || 0)
      if (!amount) return row
      const booked = await bookRow(amount, currency, formatDate(date))
      return { ...row, parsed: { ...row.parsed, ...booked } }
    }))
    } catch (err: any) {
      setAnalyzeError(`Kurs nije dostupan: ${err.message}. Analiza je zaustavljena.`)
      setAnalyzing(false)
      return
    }
    setRows(rowsWithRates)
    const partnerNames = partners.map(p => p.name).join(', ')
    const batchSize = 5
    const snapshot = [...rowsWithRates]
    const result: ImportRow[] = snapshot.map(r => ({ ...r }))
    for (let i = 0; i < snapshot.length; i += batchSize) {
      const batch = snapshot.slice(i, i + batchSize)
      const batchPayload = batch.map(r => ({ row_id: r.parsed.id, date: r.parsed.date, partner: r.parsed.partner_name, description: r.parsed.description, debit: r.parsed.debit, credit: r.parsed.credit, reference: r.parsed.reference_number }))
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/ai-categorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseAnonKey}`, 'apikey': supabaseAnonKey || '' },
          body: JSON.stringify({ rows: batchPayload, partnerNames }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        let proposals: AIProposal[] = []
        try { proposals = JSON.parse((data.result || '[]').replace(/```json|```/g, '').trim()) } catch { proposals = [] }
        for (let j = i; j < Math.min(i + batchSize, snapshot.length); j++) {
          const proposal = proposals.find((p: any) => p.row_id === snapshot[j].parsed.id)
          if (proposal) {
            const isExpense = (snapshot[j].parsed.debit || 0) > 0
            const matchedCat = plCategories.find(c => c.name === proposal.pl_category)
            const matchedDept = departments.find(d => d.name === proposal.department)
            const existingTxType = result[j].override_tx_type
            const resolvedTxType = existingTxType === 'passthrough' ? 'passthrough' : (proposal.tx_type || 'direct')
            // Preserve partner_id if already matched by account number
            const existingPartnerId = result[j].override_partner_id
            result[j] = {
              ...result[j], proposal, status: 'accepted',
              override_tx_type: resolvedTxType,
              override_tx_subtype: proposal.tx_subtype || (isExpense ? 'expense' : 'revenue'),
              override_pl_category_id: matchedCat?.id || '',
              override_pl_category_name: matchedCat?.name || proposal.pl_category || '',
              override_pl_subcategory_id: '', override_pl_subcategory_name: '',
              override_department_id: matchedDept?.id || '',
              override_department_name: matchedDept?.name || proposal.department || '',
              override_dept_subcategory_id: '', override_dept_subcategory_name: '',
              override_expense_description: proposal.expense_description || '',
              override_revenue_stream: proposal.revenue_stream || '',
              // Only override partner if not already matched by account
              override_partner_name: existingPartnerId ? result[j].override_partner_name : (proposal.partner_match || snapshot[j].parsed.partner_name),
              override_partner_id: existingPartnerId || '',
            }
          }
        }
      } catch (err: any) { setAnalyzeError(`AI analiza nije uspela: ${err.message}`); setAnalyzing(false); return }
      setProgress(Math.round(((i + batchSize) / snapshot.length) * 100))
    }
    setRows(result)
    setAnalyzing(false)
    setStep('review')
  }

  const updateRow = useCallback((id: string, updates: Partial<ImportRow>) => {
    setRows(prev => prev.map(r => r.parsed.id === id ? { ...r, ...updates } : r))
  }, [])

  const toggleExpand = (id: string) => setExpandedRow(prev => prev === id ? null : id)
  const acceptRow = (id: string) => updateRow(id, { status: 'accepted' })
  const rejectRow = (id: string) => updateRow(id, { status: 'rejected' })
  // Vec uvezeni redovi se namjerno preskacu: baza bi ih ionako odbila, a
  // prihvatanje bi korisniku prikazalo broj koji nikad nece biti proknjizen.
  const acceptAll = () => setRows(prev => prev.map(r =>
    r.already_imported ? r : { ...r, status: 'accepted' as RowStatus }))
  const rejectAll = () => setRows(prev => prev.map(r => ({ ...r, status: 'rejected' as RowStatus })))

  const postAccepted = async () => {
    setStep('posting'); setProgress(0)
    const accepted = rows.filter(r => r.status === 'accepted')
    let done = 0
    // Every write below can succeed while the result is still not what the
    // rows promised — see services/settlementCheck.ts. Collected as the run
    // goes, checked once at the end.
    const settlementExpectations: Expectation[] = []
    const localPartners = [...partners]
    // The four stored columns of a row: as the analysis step attached them
    // when the amount is the one it booked, otherwise at the NBS rates for
    // the row's date.
    const bookRow = makeBooker()
    const bookFor = async (p: any, amount: number): Promise<BookAmounts> => {
      const attached = attachedBook(p)
      const analysedAmount = (p.debit || 0) > 0 ? (p.debit || 0) : (p.credit || 0)
      if (attached && analysedAmount === amount) return attached
      return bookRow(amount, p.currency, formatDate(p.date))
    }

    // Pre-flight: svi kursevi se provjere PRIJE prvog upisa, da import ne
    // ostane napola odradjen. Valuta kredita se takodje provjeri ovdje.
    // An advance with no project, a split, or an invoice is refused by the
    // database partway through the run; refused here, before the first write.
    for (const row of accepted) {
      const why = whyAdvanceNotSavable({
        type: row.override_tx_type, subtype: row.override_tx_subtype, isAdvance: row.override_is_advance,
        projectId: projectIdFromInput(row.override_project_id),
        splitLines: row.override_pl_splits.length,
      })
      if (why) {
        setAnalyzeError(`${formatDate(row.parsed.date)} ${row.parsed.description || ''}: ${why} Ništa nije proknjiženo.`)
        setStep('review')
        return
      }
    }
    // The credit legs' headings, before the first write: an import with a
    // credit payment and no system category for it is refused whole.
    let creditHeads: CreditLegs | null = null
    if (accepted.some(r => r.override_tx_type === 'credit_payment' && r.override_installment_ids.length > 0)) {
      try {
        creditHeads = creditLegsFrom(systemCategories.map)
      } catch (err: any) {
        setAnalyzeError(`${err.message} Ništa nije proknjiženo.`)
        setStep('review')
        return
      }
    }
    try {
      for (const row of accepted) {
        const p = row.parsed
        await bookFor(p, Math.abs(p.debit || p.credit || 0))
        if (row.override_tx_type === 'credit_payment' && row.override_installment_ids.length > 0) {
          const credit = credits.find((c: any) => c.id === row.override_credit_id)
          checkCreditCurrency(credit?.currency, credit?.name)
        }
      }
    } catch (err: any) {
      setAnalyzeError(err instanceof UnsupportedCreditCurrencyError
        ? `${err.message}. Ništa nije proknjiženo.`
        : `Kurs nije dostupan: ${err.message}. Ništa nije proknjiženo.`)
      setStep('review')
      return
    }

    // Idempotentnost — vidi 20260826100000_import_idempotency.sql
    const importBatchId = crypto.randomUUID()
    let skippedDuplicates = 0

    for (let rowIndex = 0; rowIndex < accepted.length; rowIndex++) {
      const row = accepted[rowIndex]
      const p = row.parsed
      // Otisak je vec izracunat pri parsiranju, nad punom listom redova.
      // Ne racuna se ponovo ovdje: `rowIndex` je indeks u PRIHVACENIM redovima,
      // pa bi odbacivanje jednog reda promijenilo otiske svima poslije njega.
      const importHash = row.import_hash
      const isExpense = (p.debit || 0) > 0
      const amount = isExpense ? (p.debit || 0) : (p.credit || 0)
      let partnerId: string | null = row.override_partner_id || null
      if (!partnerId) {
        const nameToMatch = row.override_partner_name || p.partner_name
        if (nameToMatch) {
          const existing = localPartners.find(pt => pt.name.toLowerCase() === nameToMatch.toLowerCase())
          if (existing) { partnerId = existing.id }
          else {
            const { data: newP } = await supabase.from('partners').insert({ name: nameToMatch }).select().single()
            if (newP) { partnerId = newP.id; localPartners.push(newP) }
          }
        }
      }
      if (row.override_tx_type === 'passthrough') {
        const rowBook = await bookFor(p, amount)
        const { error: ptErr } = await supabase.from('passthrough').insert({ import_hash: importHash, import_batch_id: importBatchId, company_id: company, bank_id: bank, partner_id: partnerId, transaction_date: formatDate(p.date), direction: row.override_pt_direction, period_month: row.override_pt_period || null, currency: p.currency, amount, ...rowBook, note: row.override_note || p.description || null, account_number: p.account_number || null, model: p.model || null, reference_number: p.reference_number || null, status: 'unpaired' })
        if (ptErr) {
          if (ptErr.code === '23505') { skippedDuplicates++; done++; setProgress(Math.round((done / accepted.length) * 100)); continue }
          throw ptErr
        }
        done++; setProgress(Math.round((done / accepted.length) * 100)); continue
      }
      const isDirectWithPL = row.override_tx_type === 'direct'
      const rowBook = await bookFor(p, amount)
      /** This bank line as a parent, for its own parts. */
      const rowParent = { currency: p.currency, exchange_rate: rowBook.exchange_rate, eur_rate: rowBook.eur_rate }
      // Only a direct row has a P&L of its own to put on a project, and a
      // split row's projects are on its lines.
      const rowProjectId = isDirectWithPL && row.override_pl_splits.length === 0
        ? projectIdFromInput(row.override_project_id) : null
      // Refused before the row is written rather than after. An import posts
      // seventy rows in a loop, and a split that cannot be stored would leave
      // one line booked as a single expense among sixty-nine booked right —
      // which nobody finds, because every other line is correct.
      if (isDirectWithPL) {
        const whyThisSplit = whySplitNotSavable(
          { amount, currency: p.currency, ...rowBook }, row.override_pl_splits)
        if (whyThisSplit) {
          throw new Error(`${formatDate(p.date)} ${p.description || ''}: ${whyThisSplit}`)
        }
      }

      // Advance, P&L, and which way an invoice payment moves cash — one rule
      // for every dialog (services/advanceReceipt.ts).
      const firstInvoiceId = row.override_linked_invoice_ids?.[0] || row.override_linked_invoice_id
      const shape = receiptShape({
        type: row.override_tx_type,
        subtype: row.override_tx_subtype,
        isAdvance: row.override_is_advance,
        bankSide: isExpense ? 'expense' : 'revenue',
        invoiceType: openInvoices.find(i => i.id === firstInvoiceId)?.type ?? null,
      })

      const { data: newTx, error: txErr } = await supabase.from('transactions').insert({
        import_hash: importHash, import_batch_id: importBatchId,
        company_id: company, bank_id: bank, partner_id: partnerId, transaction_date: formatDate(p.date), statement_number: p.statement_number || null, type: row.override_tx_type, tx_subtype: shape.tx_subtype, is_advance: shape.is_advance, payment_method: row.override_payment_method || null, currency: p.currency, amount, ...rowBook, pl_impact: shape.pl_impact,
        pl_category: isDirectWithPL ? (row.override_pl_category_name || null) : null, pl_subcategory: isDirectWithPL ? (row.override_pl_subcategory_name || null) : null, department: isDirectWithPL ? (row.override_department_name || null) : null, dept_subcategory: isDirectWithPL ? (row.override_dept_subcategory_name || null) : null, expense_description: isDirectWithPL ? (row.override_expense_description || null) : null, revenue_stream: isDirectWithPL ? (row.override_revenue_stream || null) : null,
        project_id: rowProjectId,
        cf_type: isDirectWithPL && row.override_tx_subtype === 'expense' ? (row.override_cf_type || null) : null, cf_frequency: row.override_cf_type === 'recurring' ? row.override_cf_frequency : null, cf_next_month_est: row.override_cf_type === 'recurring' ? (row.override_cf_next_month_est ? parseFloat(row.override_cf_next_month_est) : amount) : null,
        account_number: p.account_number || null, model: p.model || null, reference_number: p.reference_number || null, note: row.override_note || p.description || null, status: 'posted',
      }).select().single()

      if (txErr) {
        // 23505 = red je vec uvezen ranije
        if (txErr.code === '23505') { skippedDuplicates++; done++; setProgress(Math.round((done / accepted.length) * 100)); continue }
        throw txErr
      }

      // ── The split, once the row has an id to belong to ────────────────
      //
      // Thrown rather than reported: an import posts in a loop, and a line
      // whose split failed is a line booked as one expense among dozens
      // booked correctly. Stopping names it; carrying on hides it.
      if (isDirectWithPL && row.override_pl_splits.length > 0 && newTx?.id) {
        const outcome = await saveSplits(
          supabase, 'transaction', newTx.id,
          { amount, currency: p.currency, ...rowBook }, row.override_pl_splits)
        if (!outcome.ok) throw new Error(`${formatDate(p.date)}: ${outcome.message}`)
      }
      if (row.override_tx_type === 'credit_payment' && row.override_installment_ids.length > 0) {
        // Rate kredita su u valuti kredita (RSD ili EUR). Svaki deo se knjizi
        // u toj valuti po kursevima ovog reda izvoda, a poslednji deo nosi
        // zaokruzivanje - services/creditPayment.ts.
        const credit = credits.find((c: any) => c.id === row.override_credit_id)
        const creditName = credit?.name || 'Kredit'
        const legs = creditLegBooker(credit?.currency, rowBook, creditName)

        // Ukupan plaćeni iznos u EUR — amount_eur reda (tačno `amount` za EUR red)
        // (amount_rsd za RSD kredit, amount_eur za EUR kredit)
        let remaining = legs.payable

        for (const instId of row.override_installment_ids) {
          if (remaining <= 0.005) break

          const { data: inst } = await supabase
            .from('credit_installments')
            .select('id, installment_no, principal_amount, interest_amount, total_amount, paid_amount, status')
            .eq('id', instId).single()
          if (!inst) continue

          // Uzmi u obzir već plaćeni iznos (partial iz prethodnih plaćanja)
          const alreadyPaid = inst.paid_amount || 0
          const remainingPrincipal = Math.max(0, inst.principal_amount - alreadyPaid)
          const remainingInterest = Math.max(0, inst.interest_amount - Math.max(0, alreadyPaid - inst.principal_amount))
          const remainingTotal = remainingPrincipal + remainingInterest

          if (remainingTotal <= 0.005) continue // već potpuno plaćeno

          let instPaid = 0

          // Same rule as the other two paths: the amount decides which leg a
          // line paid, instead of principal always going first.
          const legSplit = allocatePayment(remaining, remainingPrincipal, remainingInterest)

          // 1. Glavnica → system category credit_principal
          if (legSplit.principal > 0.005) {
            const paidPrincipal = legSplit.principal
            remaining = Math.max(0, remaining - paidPrincipal)
            instPaid += paidPrincipal

            await supabase.from('transactions').insert({
              company_id: company, bank_id: bank,
              partner_id: partnerId, transaction_date: formatDate(p.date),
              statement_number: p.statement_number || null,
              type: 'credit_payment', tx_subtype: 'expense',
              ...legs.book(paidPrincipal),
              pl_impact: true, ...creditHeads!.principal,
              cf_type: 'recurring', cf_frequency: 'monthly',
              note: creditNote('principal', creditName, inst.installment_no, paidPrincipal, row.override_note || p.description, legs.currency),
              status: 'posted',
            })
          }

          // 2. Kamata → system category credit_interest
          if (legSplit.interest > 0.005) {
            const paidInterest = legSplit.interest
            remaining = Math.max(0, remaining - paidInterest)
            instPaid += paidInterest

            await supabase.from('transactions').insert({
              company_id: company, bank_id: bank,
              partner_id: partnerId, transaction_date: formatDate(p.date),
              statement_number: p.statement_number || null,
              type: 'credit_payment', tx_subtype: 'expense',
              ...legs.book(paidInterest),
              pl_impact: true, ...creditHeads!.interest,
              cf_type: 'recurring', cf_frequency: 'monthly',
              note: creditNote('interest', creditName, inst.installment_no, paidInterest, row.override_note || p.description, legs.currency),
              status: 'posted',
            })
          }

          // 3. Ažuriraj ratu: partial ili paid
          const totalPaid = alreadyPaid + instPaid
          const instFullyPaid = totalPaid >= inst.total_amount - 0.005

          await supabase.from('credit_installments').update({
            paid_amount: Math.round(totalPaid * 100) / 100,
            status: instFullyPaid ? 'paid' : 'outstanding', // ostaje outstanding ako nije u potpunosti plaćeno
            paid_date: instFullyPaid ? formatDate(p.date) : null,
            updated_at: new Date().toISOString(),
          }).eq('id', instId)
        }

        // Zatvori kredit samo ako su sve rate plaćene
        if (row.override_credit_id) {
          const { data: rem } = await supabase.from('credit_installments').select('id')
            .eq('credit_id', row.override_credit_id).eq('status', 'outstanding')
          if (rem && rem.length === 0)
            await supabase.from('credits')
              .update({ status: 'closed', updated_at: new Date().toISOString() })
              .eq('id', row.override_credit_id)
        }
        done++; setProgress(Math.round((done / accepted.length) * 100)); continue
      }


      if (row.override_tx_type === 'invoice_payment' && newTx?.id) {
        // Build list of invoices to close — multi-invoice support
        const invoiceIds = row.override_linked_invoice_ids?.length > 0
          ? row.override_linked_invoice_ids
          : row.override_linked_invoice_id ? [row.override_linked_invoice_id] : []

        if (invoiceIds.length > 0) {
          // remainingOrig tracks how much of the PAYMENT is left to allocate,
          // in the payment's own currency; its RSD figure is that part of the
          // line at the line's rate (`rowParent`).
          let remainingOrig = amount   // original currency amount (e.g. RSD)

          for (const invoiceId of invoiceIds) {
            if (remainingOrig <= 0) break

            // Fetch invoice details including is_indexed flag
            const { data: inv } = await supabase.from('invoices')
              .select('id, invoice_number, type, amount, amount_rsd, amount_eur, currency, exchange_rate, eur_rate, is_indexed, advance_deducted')
              .eq('id', invoiceId).single()
            if (!inv) continue

            // ── One currency, and it has to be the same one ───────────────
            //
            // `remainingOrig` is what is left of the PAYMENT, in the payment's
            // currency. `remainingInvOrig` is what is left of the INVOICE, in
            // the invoice's. Taking `Math.min` of the two compared euros with
            // dinars, and for a EUR payment against a dinar invoice it always
            // picked the euros — so the link recorded about 6,074 against a
            // bill of 712,957 while the book column came out right. That is
            // the fault behind every "remaining 0 and still partial" invoice.
            //
            // So the comparison happens in RSD, which both sides have, and
            // the invoice's own currency figure is converted from that with
            // the invoice's own rate. The `is_indexed` rate switch is gone with
            // it: its comment said it existed to stop FX differences leaving
            // invoices partial, which it did by making the arithmetic agree
            // with the wrong number. The gap is real and is booked as a
            // currency difference now.
            const { data: prevAlloc } = await supabase.from('invoice_transaction_links')
              .select('allocated_amount').eq('invoice_id', invoiceId)
            const alreadyAllocOrig = (prevAlloc || []).reduce((s: number, r: any) => s + (r.allocated_amount || 0), 0)
            // Net of the advance a revenue billing deducts: that part is
            // settled already, and the investor does not pay it again.
            const advanceOwn = Number(inv.advance_deducted) || 0
            const remainingInvOrig = Math.max(0, (inv.amount || 0) - advanceOwn - alreadyAllocOrig)

            if (remainingInvOrig <= 0.005) continue // already paid

            // WHERE THE PAYMENT AND THE BILL SHARE A CURRENCY, NOTHING IS
            // CONVERTED. Taking `Math.min` of the payment in the reporting
            // currency at the PAYMENT date's rate and the invoice at the
            // INVOICE date's, and converting the smaller back, left a bill
            // that had been paid in full short by whatever had moved between
            // the two dates. See services/settleInvoice.ts.
            const remainingPayRsd = partBookAmounts(remainingOrig, rowParent).amount_rsd
            const settlement = settlementFor({
              invoice: { ...inv, paid_amount: alreadyAllocOrig },
              paymentCurrency: p.currency,
              paymentOwn: remainingOrig,
              paymentRsd: remainingPayRsd,
            })
            const allocOwn = settlement.own

            await supabase.from('invoice_transaction_links').insert({
              invoice_id: invoiceId,
              transaction_id: newTx.id,
              ...linkAmountsFromOwn(allocOwn, inv),
            })

            // What is left of the payment, in the unit the loop counts in.
            remainingOrig = settlement.leftOnPayment

            // What this invoice will hold once this row is done: whatever
            // already settled part of it, plus this allocation. A currency
            // gain linked below adds to it.
            settlementExpectations.push({
              invoiceId: invoiceId,
              invoiceNumber: inv.invoice_number || null,
              amount: inv.amount || 0,
              allocated: alreadyAllocOrig + allocOwn,
              amountRsd: inv.amount_rsd ?? null,
              advanceDeducted: advanceOwn,
            })

            // Update invoice status based on original currency (prevents FX rounding partial)
            const { data: allAlloc } = await supabase.from('invoice_transaction_links')
              .select('allocated_amount').eq('invoice_id', invoiceId)
            const totalAllocatedOrig = (allAlloc || []).reduce((s: number, r: any) => s + (r.allocated_amount || 0), 0)
            const invStatus = settledStatus(inv.amount || 0, totalAllocatedOrig, inv.amount_rsd, advanceOwn)
            await supabase.from('invoices')
              .update({ status: invStatus, updated_at: new Date().toISOString() })
              .eq('id', invoiceId)

            // Auto-close children if parent is fully paid
            const { data: children } = await supabase.from('invoices')
              .select('id, amount, amount_rsd, advance_deducted').eq('parent_invoice_id', invoiceId)
            if (children && children.length > 0) {
              if (invStatus === 'paid') {
                for (const child of children) {
                  await supabase.from('invoices').update({ status: 'paid', updated_at: new Date().toISOString() }).eq('id', child.id)
                }
              } else {
                for (const child of children) {
                  // Use original currency ratio for children too
                  // The child's share of what the parent took, in the child's
                  // own currency — the same unit its own `amount` is in.
                  const childShare = (inv.amount || 0) > 0 ? allocOwn / (inv.amount || 1) : 0
                  const childAllocOrig = Math.round((child.amount || 0) * childShare * 100) / 100
                  // A child is a part of the parent invoice, so its link is
                  // booked at the PARENT's stored rates.
                  await supabase.from('invoice_transaction_links').insert({
                    invoice_id: child.id, transaction_id: newTx.id,
                    ...linkAmountsFromOwn(childAllocOrig, inv),
                  })
                  const childStatus = settledStatus(child.amount || 0, childAllocOrig, child.amount_rsd, Number(child.advance_deducted) || 0)
                  await supabase.from('invoices').update({ status: childStatus, updated_at: new Date().toISOString() }).eq('id', child.id)
                }
              }
            }
          }

          // ── The currency difference ────────────────────────────────────
          //
          // Only for a row that closes ONE invoice. The loop above spreads a
          // payment across several in order, so with more than one there is no
          // single invoice a shortfall can be attributed to — which of them it
          // belongs to is a judgement, not arithmetic.
          //
          // A gain is linked, because nothing else will close the rest of the
          // invoice. A loss is not: the invoice is already settled and the
          // surplus is part of this same bank line.
          const fxScript = quickFillScripts.find(sc => sc.id === row.override_fx_script_id)
            || findCurrencyDifference(quickFillScripts)

          if (row.override_fx_book && invoiceIds.length === 1 && fxScript) {
            const { data: inv } = await supabase.from('invoices')
              .select('id, invoice_number, type, amount, amount_rsd, amount_eur, currency, exchange_rate, eur_rate, project_id, advance_deducted')
              .eq('id', invoiceIds[0]).single()
            const { data: st } = await supabase.from('v_invoice_status')
              .select('amount, paid_amount').eq('id', invoiceIds[0]).maybeSingle()

            if (inv) {
              // In the invoice's own currency, from the column the
              // settled/partial rule reads, and converted once to RSD at the
              // invoice's rate. The book remainder carries every earlier
              // payment's rate and would report a gap on bills that had in
              // fact been settled exactly.
              const shortfallOwn = outstandingOwn({ ...inv, paid_amount: st?.paid_amount ?? 0 })
              const shortfallRsd = toRsd(shortfallOwn, inv)
              const spareOrig = Math.max(0, remainingOrig)
              const difference = differenceFor({
                invoiceShortfall: shortfallRsd,
                // What is left of the line, at the line's rate.
                paymentUnallocated: partBookAmounts(round2(spareOrig), rowParent).amount_rsd,
                currency: 'RSD',
                // A receipt short of a revenue billing is a loss, not a gain.
                invoiceType: inv.type ?? null,
              })

              if (isBookable(difference)) {
                // The LINKED side - the rest of the invoice: a gain on a
                // supplier's bill, a loss on a revenue billing.
                const isGain = difference.linksToInvoice
                const fxOwn = isGain
                  // The gain IS the rest of the bill, to the para.
                  ? shortfallOwn
                  : Math.round(spareOrig * 100) / 100
                const fxCurrency = isGain ? (inv.currency || p.currency) : p.currency
                // A gain is a part of the invoice, booked at its stored rates;
                // a loss a part of the bank line, at the line's.
                const fxBook = partBookAmounts(fxOwn, isGain ? { ...inv, currency: fxCurrency } : rowParent)
                const fxRates = isGain
                  ? { exchange_rate: inv.exchange_rate, eur_rate: inv.eur_rate }
                  : { exchange_rate: rowBook.exchange_rate, eur_rate: rowBook.eur_rate }

                const { data: fxTx, error: fxErr } = await supabase.from('transactions').insert({
                  company_id: company, bank_id: bank,
                  partner_id: partnerId || null,
                  transaction_date: formatDate(p.date),
                  statement_number: p.statement_number || null,
                  type: 'direct',
                  tx_subtype: difference.direction === 'revenue' ? 'revenue' : 'expense',
                  currency: fxCurrency,
                  amount: fxOwn,
                  ...fxRates,
                  amount_rsd: fxBook.amount_rsd,
                  amount_eur: fxBook.amount_eur,
                  pl_impact: true,
                  pl_category: fxScript.pl_category || null,
                  pl_subcategory: fxScript.pl_subcategory || null,
                  department: fxScript.department || null,
                  dept_subcategory: fxScript.dept_subcategory || null,
                  expense_description: fxScript.expense_description || null,
                  // On the bill's project: the difference is part of what that
                  // bill cost or earned.
                  project_id: inv.project_id ?? null,
                  // A gain never touched the bank — see services/cashBasis.ts.
                  cf_type: isGain ? 'accrual' : (fxScript.cf_type || null),
                  status: 'posted',
                  note: entryNote(inv.invoice_number || null, difference),
                }).select('id').single()
                if (fxErr) throw new Error(`Kursna razlika nije proknjižena: ${fxErr.message}`)

                if (difference.linksToInvoice && fxTx?.id) {
                  const { error: fxLinkErr } = await supabase.from('invoice_transaction_links').insert({
                    invoice_id: inv.id, transaction_id: fxTx.id,
                    ...linkAmountsFromOwn(shortfallOwn, inv),
                  })
                  if (fxLinkErr) throw new Error(`Kursna razlika je proknjižena, ali nije mogla da se poveže sa fakturom: ${fxLinkErr.message}`)
                  const seen = settlementExpectations.find(e => e.invoiceId === inv.id)
                  if (seen) seen.allocated += shortfallOwn
                  await supabase.from('invoices')
                    .update({ status: 'paid', updated_at: new Date().toISOString() })
                    .eq('id', inv.id)
                }
              }
            }
          }
        }
      }
      done++; setProgress(Math.round((done / accepted.length) * 100))
    }
    // Log this import
    if (rows.length > 0) {
      const dates = accepted.map(r => r.parsed.date).filter(Boolean).sort()
      const dateFrom = dates[0] ? dates[0].split('.').reverse().join('-') : null
      const dateTo = dates[dates.length - 1] ? dates[dates.length - 1].split('.').reverse().join('-') : null
      await supabase.from('import_logs').insert({
        company_id: company,
        bank_id: bank,
        import_type: 'bank_statement',
        file_name: fileName,
        date_from: dateFrom,
        date_to: dateTo,
        row_count: accepted.length - skippedDuplicates,
        note: skippedDuplicates > 0
          ? `Proknjiženo stavki: ${accepted.length - skippedDuplicates}, preskočeno kao već uvezeno: ${skippedDuplicates}`
          : `Proknjiženo stavki: ${accepted.length}`,
        filing_ref: importBatchId,
      })
    }
    // Did the invoices end up where the rows said they would? Nothing here
    // can be undone by this point; this exists so nobody walks away from a
    // finished import that did not do what it showed.
    if (settlementExpectations.length > 0) {
      const { data: after } = await supabase.from('v_invoice_status')
        .select('id, calculated_status')
        .in('id', settlementExpectations.map(e => e.invoiceId))
      const actual: Record<string, Settlement | undefined> = {}
      for (const r of after || []) actual[r.id] = r.calculated_status as Settlement
      const bad = describeMismatches(mismatches(settlementExpectations, actual))
      setSettlementWarning(bad)
    }

    setStep('done')
  }

  const accepted = rows.filter(r => r.status === 'accepted').length
  const rejected = rows.filter(r => r.status === 'rejected').length
  const pending = rows.filter(r => r.status === 'pending').length
  // ── What this batch has already spoken for ──────────────────────────────
  //
  // Nothing is written until the whole import is posted, so until then every
  // row is offered the same open invoices. Three rows would happily tick the
  // same rent invoice while two others were never ticked at all, and the
  // allocator — which walks the rows in order and gives each invoice out once
  // — would close one and leave the others open. This runs that allocator's
  // arithmetic early so the picker stops offering what it will not deliver.
  //
  // Rejected and already-imported rows hold nothing: they are not going to be
  // posted, so what they ticked is not claimed.
  const claimRows = useMemo<ClaimRow[]>(() => rows
    .filter(r => r.override_tx_type === 'invoice_payment'
      && r.status !== 'rejected' && !r.already_imported)
    .map(r => {
      const own = (r.parsed.debit || 0) > 0 ? (r.parsed.debit || 0) : (r.parsed.credit || 0)
      const attached = r.parsed.currency === 'RSD' ? own : (attachedBook(r.parsed)?.amount_rsd || 0)

      // ── Working the dinar figure out rather than giving up on it ───────
      //
      // `amount_rsd` is attached by the analysis step and is missing on a row
      // that skipped it. The row still knows what it paid, in its own
      // currency, and the FIRST invoice it ticked carries the rate it was
      // booked at. Where the two currencies agree, that rate converts the
      // payment.
      //
      // For the picker only. Nothing here is posted; the posting fetches the
      // official rate for the day. What it buys is a partial payment staying
      // partial: a row paying half an invoice must leave the other half on
      // offer, and an unknown amount cannot do that.
      const first = (r.override_linked_invoice_ids || [])[0]
      const inv = first ? openInvoices.find(i => i.id === first) : null
      const viaInvoice = inv && inv.currency === r.parsed.currency && (inv.exchange_rate || 0) > 0
        ? toRsd(own, inv)
        : 0
      const rsd = attached > 0 ? attached : viaInvoice

      return {
        id: r.parsed.id,
        // ── An unknown amount is the WHOLE invoice, not none of it ───────
        //
        // The claims are compared in RSD, and `amount_rsd` is attached by
        // `analyzeWithAI`. A row that never went through it — or one whose
        // rate lookup gave nothing — had no dinar figure, and this read that
        // as a claim of zero: the row plainly closed a 505,023 RSD invoice,
        // claimed nothing, and the invoice went on being offered to every
        // other line of the statement. Which is the exact trap the claims
        // exist to close, reopened by a silent zero.
        //
        // Only where it genuinely cannot be worked out — a row in one
        // currency against an invoice in another, with no rate on file — is
        // it taken to settle what it ticked in full, the way the bank
        // statement dialog has always taken it. The two errors are not equal:
        // offering an invoice that is already spoken for leaves another one
        // open and still reconciles to the penny, while hiding one that had
        // room is visible, says so, and has a button beside it.
        amount: rsd > 0 ? rsd : Number.POSITIVE_INFINITY,
        invoiceIds: r.override_linked_invoice_ids || [],
      }
    }), [rows, openInvoices])

  /** A row id means nothing to a person; its position in the list does. */
  const claimRowLabel = useCallback((rowId: string) => {
    const idx = rows.findIndex(r => r.parsed.id === rowId)
    return idx >= 0 ? `stavka ${idx + 1}` : 'druga stavka'
  }, [rows])

  const alreadyImported = rows.filter(r => r.already_imported).length

  const confStyle = (c?: string) => {
    if (c === 'high') return { bg: DIALOG.accentFill, color: DIALOG.accent }
    if (c === 'medium') return { bg: DIALOG.amberFill, color: DIALOG.amber }
    return { bg: DIALOG.redFill, color: DIALOG.red }
  }

  const getTxTypeBadge = (type: string) => {
    if (type === 'direct') return { bg: DIALOG.accentFill, color: DIALOG.accent, label: '⚡ Direktna' }
    if (type === 'passthrough') return { bg: DIALOG.amberFill, color: DIALOG.amber, label: '🔄 Prolazna' }
    return { bg: DIALOG.blueFill, color: DIALOG.blue, label: '💳 Plać. fakture' }
  }

  if (step === 'done') return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '260px' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(0,212,126,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={DIALOG.accent} strokeWidth="2"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: '22px', color: '#DCE9F6' }}>Uvoz je završen.</div>
        <div style={{ fontSize: '13px', color: '#7A9BB8', textAlign: 'center' as const }}>Proknjiženo stavki: {accepted}.<br />Preskočeno: {rejected}.</div>
        {settlementWarning && (
          <div style={{
            fontSize: '12px', lineHeight: 1.5, color: DIALOG.amber, background: DIALOG.amberFill,
            border: '0.5px solid ' + DIALOG.amber, borderRadius: '8px', padding: '10px 14px',
            maxWidth: '560px', textAlign: 'left' as const,
          }}>
            ⚠ {settlementWarning}
          </div>
        )}
        <button style={s.btnPrimary} onClick={() => { onImported(); onClose() }}>Prikaži transakcije</button>
      </div>
    </div>
  )

  if (step === 'posting') return (
    <div style={s.overlay}>
      <div style={{ ...s.dialog, alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '260px' }}>
        <div style={{ fontSize: '13px', color: DIALOG.dim }}>Knjiženje… {progress}%</div>
        <div style={{ ...s.progressBar, width: '300px' }}><div style={{ ...s.progressFill, width: `${progress}%` }} /></div>
      </div>
    </div>
  )

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        <div style={s.header}>
          <div>
            <div style={s.headerTitle}>{step === 'upload' ? '📥 Grupni uvoz — izvod' : `📋 Pregled i knjiženje — stavki: ${rows.length}`}</div>
            <div style={s.headerSub}>{step === 'upload' ? 'Podržano: Raiffeisen/Intesa · Truist · Bank of America · Amex · Wio' : `prihvaćeno: ${accepted} · odbijeno: ${rejected} · na čekanju: ${pending}`}</div>
          </div>
          <button style={s.closeBtn} onClick={onClose}>×</button>
        </div>

        <div style={s.body}>
          {step === 'upload' && (
            <>
              <div style={s.section}>
                <div style={s.sectionTitle}>Firma i banka</div>
                <div style={s.row2}>
                  {showPicker && (
                    <div style={s.field}>
                      <label style={s.lbl}>Firma <span style={s.req}>*</span></label>
                      <select style={s.select} value={company} onChange={e => setCompany(e.target.value)}>
                        <option value="">Izaberite firmu…</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div style={s.field}>
                    <label style={s.lbl}>Tekući račun <span style={s.req}>*</span></label>
                    <select style={s.select} value={bank} onChange={e => setBank(e.target.value)} disabled={!company}>
                      <option value="">Izaberite banku…</option>
                      {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div style={s.section}>
                <div style={s.sectionTitle}>Otpremanje fajla</div>
                <div style={s.dropZone} onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileRef.current?.click()}>
                  <input ref={fileRef} type="file" accept=".txt,.csv,.xlsx,.xls" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }} />
                  {fileName ? (
                    <div>
                      <div style={{ fontSize: '24px', marginBottom: '8px' }}>📄</div>
                      <div style={{ fontSize: '14px', fontWeight: '500', color: DIALOG.accent }}>{fileName}</div>
                      {detectedFormat && <div style={{ fontSize: '12px', color: DIALOG.accent, marginTop: '4px', background: DIALOG.accentFill, padding: '3px 10px', borderRadius: '20px', display: 'inline-block' }}>{FORMAT_LABELS[detectedFormat]} detected</div>}
                      {encodingNote && <div style={{ fontSize: '11px', color: DIALOG.amber, marginTop: '4px' }}>{encodingNote}</div>}
                      <div style={{ fontSize: '12px', color: DIALOG.dim, marginTop: '6px' }}>Učitano stavki: {rows.length} — kliknite za promenu</div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: '32px', marginBottom: '12px' }}>📂</div>
                      <div style={{ fontSize: '14px', fontWeight: '500', color: DIALOG.text, marginBottom: '8px' }}>Prevucite fajl ovde ili kliknite da ga izaberete</div>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap' as const }}>
                        {Object.entries(FORMAT_LABELS).map(([k, v]) => (
                          <span key={k} style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '20px', background: DIALOG.raised, color: DIALOG.dim }}>{v}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {parseError && <div style={s.errorMsg}>⚠️ {parseError}</div>}
              </div>
              {rows.length > 0 && (
                <div style={s.section}>
                  <div style={s.sectionTitle}>Pregled učitanog</div>
                  <div style={s.infoBox}>
                    <strong>stavki: {rows.length}</strong> · <strong>troškova: {rows.filter(r => (r.parsed.debit || 0) > 0).length}</strong> · <strong>prihoda: {rows.filter(r => (r.parsed.credit || 0) > 0).length}</strong>
                    {detectedFormat && <span style={{ marginLeft: '8px', opacity: 0.8 }}>· {FORMAT_LABELS[detectedFormat]}</span>}
                    {rows.filter(r => r.override_partner_id).length > 0 && (
                      <span style={{ marginLeft: '8px', color: DIALOG.accent }}>· ✓ partnera prepoznatih po broju računa: {rows.filter(r => r.override_partner_id).length}</span>
                    )}
                  </div>
                  <div style={s.previewList}>
                    {rows.slice(0, 5).map(r => (
                      <div key={r.parsed.id} style={s.previewRow}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{r.override_partner_name || r.parsed.partner_name || '—'}</div>
                            {r.override_partner_id && <span style={{ fontSize: '10px', color: DIALOG.accent, background: DIALOG.accentFill, padding: '1px 6px', borderRadius: '20px' }}>✓ prepoznat</span>}
                          </div>
                          <div style={{ fontSize: '11px', color: '#7A9BB8' }}>{r.parsed.date} · {r.parsed.description?.slice(0, 60)}</div>
                        </div>
                        <div style={{ textAlign: 'right' as const }}>
                          {(r.parsed.debit || 0) > 0 && <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.red }}>-{fmtMoney(r.parsed.debit || 0, r.parsed.currency)}</div>}
                          {(r.parsed.credit || 0) > 0 && <div style={{ fontSize: '13px', fontWeight: '500', color: DIALOG.accent }}>+{fmtMoney(r.parsed.credit || 0, r.parsed.currency)}</div>}
                        </div>
                      </div>
                    ))}
                    {rows.length > 5 && <div style={{ padding: '8px 14px', fontSize: '12px', color: DIALOG.faint, textAlign: 'center' as const }}>+ još {rows.length - 5} stavki…</div>}
                  </div>
                </div>
              )}
              {company && bank && (
                <div style={{ ...s.section, marginTop: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '10px' }}
                    onClick={() => setHistoryExpanded(prev => !prev)}>
                    <div style={{ fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.1em' }}>
                      🕐 Prethodni uvozi — ovaj račun
                      {importHistory.length > 0 && <span style={{ marginLeft: '8px', background: 'rgba(0,212,126,0.15)', color: '#00D47E', padding: '1px 7px', borderRadius: '20px', fontSize: '10px' }}>{importHistory.length}</span>}
                    </div>
                    <span style={{ fontSize: '10px', color: '#7A9BB8' }}>{historyExpanded ? '▲ Sakrij' : '▼ Prikaži'}</span>
                  </div>
                  {historyExpanded && (
                    importHistory.length === 0 ? (
                      <div style={{ fontSize: '12px', color: '#7A9BB8', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                        Za ovaj račun nema prethodnih uvoza.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px', maxHeight: '220px', overflowY: 'auto' as const }}>
                        {importHistory.map(log => (
                          <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{log.file_name || 'Nepoznat fajl'}</div>
                              <div style={{ fontSize: '11px', color: '#7A9BB8', marginTop: '2px' }}>
                                {log.date_from && log.date_to ? `${log.date_from} → ${log.date_to}` : log.date_from || '—'}
                                {log.row_count ? ` · stavki: ${log.row_count}` : ''}
                              </div>
                            </div>
                            <div style={{ fontSize: '11px', color: '#7A9BB8', whiteSpace: 'nowrap' as const }}>
                              {new Date(log.created_at).toLocaleDateString('sr-Latn-RS')}
                            </div>
                            <div style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '20px', background: 'rgba(0,212,126,0.10)', color: '#00D47E' }}>✓ Uvezeno</div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
              {analyzing && (
                <div style={s.analyzingBox}>
                  <div style={{ fontSize: '13px', color: DIALOG.accent, marginBottom: '8px' }}>🤖 AI analizira stavke ({rows.length})…</div>
                  <div style={s.progressBar}><div style={{ ...s.progressFill, width: `${progress}%`, transition: 'width 0.5s' }} /></div>
                  <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '6px' }}>završeno {progress}%</div>
                </div>
              )}
              {analyzeError && <div style={{ ...s.infoBox, background: DIALOG.redFill, borderColor: DIALOG.redSoft, color: DIALOG.red, marginTop: '12px' }}>⚠️ {analyzeError}</div>}
            </>
          )}

          {step === 'review' && (
            <>
              <div style={s.reviewSummary}>
                <div style={s.reviewStat}><span style={{ fontSize: '20px', fontWeight: '600', color: DIALOG.accent }}>{accepted}</span><span style={{ fontSize: '11px', color: '#7A9BB8' }}>Prihvaćeno</span></div>
                <div style={s.reviewStat}><span style={{ fontSize: '20px', fontWeight: '600', color: DIALOG.red }}>{rejected}</span><span style={{ fontSize: '11px', color: '#7A9BB8' }}>Odbijeno</span></div>
                <div style={s.reviewStat}><span style={{ fontSize: '20px', fontWeight: '600', color: DIALOG.amber }}>{pending}</span><span style={{ fontSize: '11px', color: '#7A9BB8' }}>Na čekanju</span></div>
                <div style={s.reviewStat}><span style={{ fontSize: '20px', fontWeight: '600', color: DIALOG.accent }}>{rows.filter(r => r.override_partner_id).length}</span><span style={{ fontSize: '11px', color: '#7A9BB8' }}>Prepoznato</span></div>
                {alreadyImported > 0 && (
                  <div style={s.reviewStat}>
                    <span style={{ fontSize: '20px', fontWeight: '600', color: '#4EA8FF' }}>{alreadyImported}</span>
                    <span style={{ fontSize: '11px', color: '#7A9BB8' }}>Već uvezeno</span>
                  </div>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                  <button style={s.btnSmallGreen} onClick={acceptAll}>✓ Prihvati sve</button>
                  <button style={s.btnSmallRed} onClick={rejectAll}>✕ Odbij sve</button>
                </div>
              </div>

              <div style={s.reviewList}>
                {rows.map(row => {
                  const p = row.parsed
                  const isExpense = (p.debit || 0) > 0
                  const amount = isExpense ? p.debit : p.credit
                  const isExpanded = expandedRow === p.id
                  const conf = row.proposal?.confidence ? confStyle(row.proposal.confidence) : null
                  const plSubs = getPlSubs(row.override_pl_category_id)
                  const deptSubs = getDeptSubs(row.override_department_id)
                  const expDescs = getExpDescs(row.override_dept_subcategory_id)
                  const linkedInvoice = openInvoices.find(i => i.id === row.override_linked_invoice_id)
                  const typeBadge = getTxTypeBadge(row.override_tx_type)
                  const rowAccounts = partnerAccounts.filter((pa: any) => pa.partner_id === row.override_partner_id)
                  const parsedAccount = p.account_number?.trim()
                  const parsedAccountClean = (parsedAccount || '').replace(/[\r\n\t]/g, '').trim()
                  const accountInDB = parsedAccountClean && rowAccounts.some((a: any) => {
                    const dbAccClean = (a.account_number || '').replace(/[\r\n\t]/g, '').trim()
                    return dbAccClean === parsedAccountClean ||
                      normalizeAccountNumber(dbAccClean) === normalizeAccountNumber(parsedAccountClean)
                  })

                  return (
                    <div key={p.id} style={{ ...s.reviewRow, ...(row.status === 'accepted' ? s.reviewRowAccepted : {}), ...(row.status === 'rejected' ? s.reviewRowRejected : {}), ...(row.override_tx_type === 'passthrough' ? s.reviewRowPassthrough : {}) }}>
                      <div style={s.reviewRowMain} onClick={() => toggleExpand(p.id)}>
                        <div style={{ flexShrink: 0, width: '14px', fontSize: '11px', color: DIALOG.faint }}>{isExpanded ? '▼' : '▶'}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px', flexWrap: 'wrap' as const }}>
                            <span style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{row.override_partner_name || p.partner_name || '—'}</span>
                            {row.override_partner_id && <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: DIALOG.accentFill, color: DIALOG.accent }}>✓ baza</span>}
                            {conf && row.proposal && <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: conf.bg, color: conf.color }}>{({ high: 'visoka', medium: 'srednja', low: 'niska' } as Record<string, string>)[row.proposal.confidence] || row.proposal.confidence}</span>}
                            <span style={{ fontSize: '10px', fontWeight: '500', padding: '1px 7px', borderRadius: '20px', background: typeBadge.bg, color: typeBadge.color }}>{typeBadge.label}</span>
                            <span style={{ fontSize: '10px', color: DIALOG.faint }}>{FORMAT_LABELS[p.source_format]}</span>
                            {row.already_imported && (
                              <span style={{
                                fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '4px',
                                background: 'rgba(78,168,255,0.15)', color: '#4EA8FF',
                              }}>
                                već uvezeno
                              </span>
                            )}
                            {effectiveAdvance(row.override_tx_type, row.override_tx_subtype, row.override_is_advance) && (
                              <span style={ADVANCE_BADGE_STYLE}>{ADVANCE_LABEL}</span>
                            )}
                          </div>
                          <div style={{ fontSize: '11px', color: '#7A9BB8' }}>{p.date} · {p.description?.slice(0, 65)}{(p.description?.length || 0) > 65 ? '...' : ''}</div>
                          {row.override_tx_type === 'direct' && row.override_pl_category_name && (
                            <div style={{ fontSize: '11px', color: DIALOG.accent, marginTop: '2px' }}>📊 {row.override_pl_category_name}{row.override_department_name ? ` · ${row.override_department_name}` : ''}</div>
                          )}
                          {row.override_tx_type === 'invoice_payment' && (
                            <div style={{ fontSize: '11px', color: DIALOG.blue, marginTop: '2px' }}>💳 Samo novčani tok{linkedInvoice ? ` · Zatvara: ${linkedInvoice.partner_name || '—'}` : ' · Bez povezane fakture'}</div>
                          )}
                          {row.override_tx_type === 'passthrough' && (
                            <div style={{ fontSize: '11px', color: DIALOG.amber, marginTop: '2px' }}>🔄 {row.override_pt_direction === 'in' ? '📥 UPLATA' : '📤 ISPLATA'} · Period: {row.override_pt_period || '—'}</div>
                          )}
                        </div>
                        <div style={{ textAlign: 'right' as const, flexShrink: 0, marginRight: '10px' }}>
                          <div style={{ fontSize: '13px', fontWeight: '500', color: isExpense ? DIALOG.red : DIALOG.accent }}>{isExpense ? '-' : '+'}{fmtMoney(amount || 0, p.currency)}</div>
                          <div style={{ fontSize: '10px', color: DIALOG.faint }}>{p.statement_number ? `Izvod #${p.statement_number}` : p.date}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                          <button style={{ ...s.actionBtn, ...(row.status === 'accepted' ? s.actionBtnAccepted : {}) }} onClick={() => acceptRow(p.id)}>✓</button>
                          <button style={{ ...s.actionBtn, ...(row.status === 'rejected' ? s.actionBtnRejected : {}) }} onClick={() => rejectRow(p.id)}>✕</button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={s.editPanel} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
                          {row.proposal && <div style={s.aiNotes}>🤖 AI: {row.proposal.notes}</div>}

                          <div style={s.editGrid2}>
                            {/* Partner field with dropdown search */}
                            <div style={s.editField}>
                              <label style={s.editLbl}>Partner</label>
                              <div style={{ position: 'relative' as const }}>
                                <input
                                  style={{ ...s.editInput, border: row.override_partner_id ? '1.5px solid ' + DIALOG.accent : '1.5px solid ' + DIALOG.border, paddingRight: '28px' }}
                                  value={reviewPartnerSearch[p.id] !== undefined ? reviewPartnerSearch[p.id] : row.override_partner_name}
                                  onChange={e => {
                                    setReviewPartnerSearch(prev => ({ ...prev, [p.id]: e.target.value }))
                                    updateRow(p.id, { override_partner_name: e.target.value, override_partner_id: '' })
                                  }}
                                  placeholder="Pretražite ili unesite partnera…"
                                />
                                <span style={{ position: 'absolute' as const, right: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '12px', color: row.override_partner_id ? DIALOG.accent : DIALOG.faint, pointerEvents: 'none' as const }}>
                                  {row.override_partner_id ? '✓' : '✎'}
                                </span>
                                {((reviewPartnerSearch[p.id] ?? '').length > 0 || (!row.override_partner_id && row.override_partner_name.length > 0)) && !row.override_partner_id && (
                                  <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, background: DIALOG.panel, border: '1px solid ' + DIALOG.border, borderRadius: '6px', zIndex: 300, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: '220px', overflowY: 'auto' as const }}>
                                    {partners.filter(pt => pt.name.toLowerCase().includes((reviewPartnerSearch[p.id] ?? row.override_partner_name).toLowerCase())).slice(0, 8).map(pt => (
                                      <div key={pt.id} style={{ padding: '7px 10px', fontSize: '12px', cursor: 'pointer', borderBottom: '0.5px solid ' + DIALOG.borderSoft, display: 'flex', flexDirection: 'column' as const }}
                                        onMouseDown={e => {
                                          e.preventDefault()
                                          updateRow(p.id, { override_partner_name: pt.name, override_partner_id: pt.id })
                                          setReviewPartnerSearch(prev => ({ ...prev, [p.id]: pt.name }))
                                        }}>
                                        <span style={{ fontWeight: '500', color: DIALOG.text }}>{pt.name}</span>
                                        {partnerAccounts.filter((pa: any) => pa.partner_id === pt.id).length > 0 && (
                                          <span style={{ fontSize: '10px', color: DIALOG.accent }}>{partnerAccounts.filter((pa: any) => pa.partner_id === pt.id).length} account(s) on file</span>
                                        )}
                                      </div>
                                    ))}
                                    {(() => {
                                      const searchTerm = reviewPartnerSearch[p.id] ?? row.override_partner_name
                                      const noMatch = partners.filter(pt => pt.name.toLowerCase().includes(searchTerm.toLowerCase())).length === 0
                                      if (!noMatch || !searchTerm.trim()) return null
                                      return (
                                        <div style={{ padding: '8px 10px', borderTop: '0.5px solid ' + DIALOG.border, background: DIALOG.raised }}>
                                          <div style={{ fontSize: '11px', color: DIALOG.dim, marginBottom: '6px' }}>„{searchTerm}“ nije u bazi partnera</div>
                                          <button
                                            style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '5px 12px', border: 'none', borderRadius: '6px', background: DIALOG.accent, color: DIALOG.onAccent, cursor: 'pointer', width: '100%' }}
                                            onMouseDown={e => { e.preventDefault(); setReviewPartnerSearch(prev => ({ ...prev, [p.id]: '' })); openPartnerDialog(p.id, searchTerm, p.account_number || '') }}>
                                            ➕ Dodaj „{searchTerm}“ kao novog partnera (uz pretragu NBS)
                                          </button>
                                        </div>
                                      )
                                    })()}
                                  </div>
                                )}
                              </div>

                              {/* Partner accounts */}
                              {rowAccounts.length > 0 && (
                                <div style={{ marginTop: '6px' }}>
                                  <label style={{ ...s.editLbl, display: 'block', marginBottom: '4px' }}>Račun partnera ({rowAccounts.length})</label>
                                  <select style={{ ...s.editSelect, border: '1.5px solid ' + DIALOG.accent, background: DIALOG.accentFill }}
                                    defaultValue={rowAccounts.find((a: any) => normalizeAccountNumber(a.account_number) === normalizeAccountNumber(parsedAccount || ''))?.account_number || rowAccounts.find((a: any) => a.is_primary)?.account_number || rowAccounts[0]?.account_number || ''}>
                                    <option value="">— Bez računa —</option>
                                    {rowAccounts.map((acc: any) => (
                                      <option key={acc.id} value={acc.account_number}>
                                        {acc.account_number}{acc.bank_name ? ` · ${acc.bank_name}` : ''}{acc.is_primary ? ' ★' : ''}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}

                              {/* Save account button if not in DB */}
                              {row.override_partner_id && parsedAccount && !accountInDB && (
                                <div style={{ marginTop: '6px', background: DIALOG.amberFill, border: '0.5px solid ' + DIALOG.amber, borderRadius: '6px', padding: '7px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                  <span style={{ fontSize: '11px', color: DIALOG.amber }}>Račun <strong>{parsedAccount}</strong> nije unet za ovog partnera</span>
                                  <button
                                    style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '3px 10px', border: 'none', borderRadius: '5px', background: DIALOG.amber, color: DIALOG.onAccent, cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                                    onClick={() => saveAccountToPartner(p.id, row.override_partner_id, parsedAccount)}>
                                    {savingAccount[p.id] ? '⏳' : '➕ Sačuvaj račun'}
                                  </button>
                                </div>
                              )}
                            </div>

                            <div style={s.editField}>
                              <label style={s.editLbl}>Tip</label>
                              <select style={s.editSelect} value={row.override_tx_type}
                                onChange={e => updateRow(p.id, { override_tx_type: e.target.value as any, override_pl_category_id: '', override_pl_category_name: '', override_pl_subcategory_id: '', override_pl_subcategory_name: '', override_department_id: '', override_department_name: '', override_dept_subcategory_id: '', override_dept_subcategory_name: '', override_expense_description: '' })}>
                                <option value="direct">⚡ Direktna (utiče na P&L)</option>
                                <option value="invoice_payment">💳 Plaćanje fakture (samo novac)</option>
                                <option value="passthrough">🔄 Prolazna stavka (tranzit)</option>
                                <option value="credit_payment">🏦 Otplata kredita (zatvara rate)</option>
                              </select>
                            </div>
                          </div>

                          {row.override_tx_type === 'passthrough' && (
                            <>
                              <div style={s.editSectionTitle}>Podaci o prolaznoj stavci</div>
                              <div style={s.editGrid2}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Smer</label>
                                  <select style={s.editSelect} value={row.override_pt_direction} onChange={e => updateRow(p.id, { override_pt_direction: e.target.value as 'in' | 'out' })}>
                                    <option value="in">📥 UPLATA</option><option value="out">📤 ISPLATA</option>
                                  </select>
                                </div>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Period (mesec)</label>
                                  <input type="month" style={s.editInput} value={row.override_pt_period} onChange={e => updateRow(p.id, { override_pt_period: e.target.value })} />
                                </div>
                              </div>
                              <div style={{ marginTop: '8px' }}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Napomena</label>
                                  <input style={s.editInput} value={row.override_note} onChange={e => updateRow(p.id, { override_note: e.target.value })} placeholder={p.description?.slice(0, 40)} />
                                </div>
                              </div>
                            </>
                          )}

                          {row.override_tx_type === 'credit_payment' && (
                            <div style={{ gridColumn: '1 / -1', marginTop: '8px' }}>
                              <div style={s.editSectionTitle}>Rate kredita</div>
                              <SystemCategoryNotice what="Otplate kredita" roles={CREDIT_ROLES}
                                map={systemCategories.map} loading={systemCategories.loading} />
                              <CreditInstallmentSelector
                                credits={credits}
                                selectedCreditId={row.override_credit_id}
                                onCreditChange={async id => {
                                  updateRow(p.id, { override_credit_id: id, override_installment_ids: [] })
                                  if (id) {
                                    const { data } = await supabase
                                      .from('credit_installments')
                                      .select('id,installment_no,due_date,principal_amount,interest_amount,total_amount,status')
                                      .eq('credit_id', id).eq('status', 'outstanding').order('due_date')
                                    if (data) setBulkInstallments(prev => ({ ...prev, [p.id]: data }))
                                  }
                                }}
                                installments={bulkInstallments[p.id] || []}
                                selectedInstallmentIds={row.override_installment_ids}
                                onToggle={id => updateRow(p.id, {
                                  override_installment_ids: row.override_installment_ids.includes(id)
                                    ? row.override_installment_ids.filter((x: string) => x !== id)
                                    : [...row.override_installment_ids, id]
                                })}
                                onToggleAll={() => {
                                  const all = (bulkInstallments[p.id] || []).map((i: any) => i.id)
                                  updateRow(p.id, {
                                    override_installment_ids:
                                      row.override_installment_ids.length === all.length ? [] : all
                                  })
                                }}
                                selectedTotal={(bulkInstallments[p.id] || [])
                                  .filter((i: any) => row.override_installment_ids.includes(i.id))
                                  .reduce((s: number, i: any) => s + i.total_amount, 0)}
                              />
                            </div>
                          )}


                          {row.override_tx_type !== 'passthrough' && (
                            <div style={{ ...s.editGrid2, marginTop: '8px' }}>
                              <div style={s.editField}>
                                <label style={s.editLbl}>Podtip</label>
                                <select style={s.editSelect} value={row.override_tx_subtype} onChange={e => updateRow(p.id, { override_tx_subtype: e.target.value as any })}>
                                  <option value="expense">📤 Trošak</option><option value="revenue">📥 Prihod</option>
                                </select>
                              </div>
                              <div style={s.editField}>
                                <label style={s.editLbl}>Napomena</label>
                                <input style={s.editInput} value={row.override_note} onChange={e => updateRow(p.id, { override_note: e.target.value })} placeholder={p.description?.slice(0, 40)} />
                              </div>
                            </div>
                          )}

                          {row.override_tx_type === 'invoice_payment' && (
                            <>
                              <div style={s.editSectionTitle}>Podaci za plaćanje</div>
                              <div style={s.editGrid2}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Način plaćanja</label>
                                  <select style={s.editSelect} value={row.override_payment_method} onChange={e => updateRow(p.id, { override_payment_method: e.target.value })}>
                                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m] || m}</option>)}
                                  </select>
                                </div>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Poveži sa otvorenom fakturom</label>
                                  {/* Selected invoices summary */}
                                  {(row.override_linked_invoice_ids?.length > 0) && !invoicePickerOpen[p.id] && (
                                    <div style={{ marginBottom: '6px' }}>
                                      {row.override_linked_invoice_ids.map((invId, idx) => {
                                        const sel = openInvoices.find(i => i.id === invId)
                                        if (!sel) return null
                                        return (
                                          <div key={invId} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(0,212,126,0.4)', background: 'rgba(0,212,126,0.06)', marginBottom: '3px' }}>
                                            <span style={{ fontSize: '10px', color: '#7A9BB8', width: '14px' }}>{idx + 1}.</span>
                                            <span style={{ fontSize: '12px', fontWeight: '500', color: '#00D47E', flex: 1 }}>{sel.partner_name || '—'}</span>
                                            <span style={{ fontSize: '10px', color: '#7A9BB8' }}>preostalo {fmtMoney(outstandingOwn(sel), sel.currency || 'RSD')}</span>
                                            <button style={{ background: 'none', border: 'none', color: '#FF5B5A', fontSize: '13px', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                                              onClick={e => { e.stopPropagation(); updateRow(p.id, { override_linked_invoice_ids: row.override_linked_invoice_ids.filter(x => x !== invId), status: row.override_linked_invoice_ids.length <= 1 ? 'pending' as RowStatus : 'accepted' as RowStatus }) }}>×</button>
                                          </div>
                                        )
                                      })}
                                      <button style={{ fontSize: '11px', color: '#7A9BB8', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
                                        onClick={e => { e.stopPropagation(); setInvoicePickerOpen(prev => ({ ...prev, [p.id]: true })) }}>
                                        ✎ Izmeni izbor
                                      </button>
                                    </div>
                                  )}
                                  {/* Search + checkbox list */}
                                  {(!(row.override_linked_invoice_ids?.length > 0) || invoicePickerOpen[p.id]) && (
                                    <>
                                  <input
                                    style={{ ...s.editInput, marginBottom: '6px' }}
                                    value={invoiceSearch[p.id] || ''}
                                    onChange={e => { e.stopPropagation(); setInvoiceSearch(prev => ({ ...prev, [p.id]: e.target.value })) }}
                                    onClick={e => e.stopPropagation()}
                                    placeholder="Pretraga po partneru ili broju fakture…"
                                    autoFocus={invoicePickerOpen[p.id]}
                                  />
                                  {(() => {
                                    // Counted over the same list the picker
                                    // shows, so the number and the absence
                                    // cannot disagree.
                                    const hidden = openInvoices.filter(inv =>
                                      !(row.override_linked_invoice_ids || []).includes(inv.id)
                                      && freeForRow(
                                        { id: inv.id, remaining: inv.remaining_rsd || 0 } as OpenInvoice,
                                        claimRows, p.id).exhausted).length
                                    if (hidden === 0) return null
                                    return (
                                      <div style={{ fontSize: '11px', color: '#7A9BB8', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span>
                                          Faktura koje su već zauzete drugom stavkom: {hidden}
                                          {showTaken[p.id] ? ' — prikazane, zasivljene' : ' — skrivene'}
                                        </span>
                                        <button
                                          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '6px', color: '#7A9BB8', fontSize: '10.5px', padding: '2px 8px', cursor: 'pointer', fontFamily: "'Inter', system-ui, sans-serif" }}
                                          onClick={e => { e.stopPropagation(); setShowTaken(prev => ({ ...prev, [p.id]: !prev[p.id] })) }}>
                                          {showTaken[p.id] ? 'Sakrij ih' : 'Prikaži ih'}
                                        </button>
                                      </div>
                                    )
                                  })()}
                                  <div style={{ maxHeight: '220px', overflowY: 'auto' as const, display: 'flex', flexDirection: 'column' as const, gap: '3px' }}>
                                    <div
                                      style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', cursor: 'pointer', fontSize: '12px', color: '#7A9BB8' }}
                                      onClick={e => { e.stopPropagation(); updateRow(p.id, { override_linked_invoice_ids: [], override_linked_invoice_id: '', status: 'pending' as RowStatus }); setInvoiceSearch(prev => ({ ...prev, [p.id]: '' })); setInvoicePickerOpen(prev => ({ ...prev, [p.id]: false })) }}>
                                      — Poništi izbor —
                                    </div>
                                    {openInvoices
                                      .filter(inv => {
                                        const q = (invoiceSearch[p.id] || '').toLowerCase()
                                        if (!q) return true
                                        return (inv.partner_name || '').toLowerCase().includes(q) || (inv.invoice_number || '').toLowerCase().includes(q)
                                      })
                                      .filter(inv => !isHiddenForRow(
                                        freeForRow(
                                          { id: inv.id, remaining: inv.remaining_rsd || 0 } as OpenInvoice,
                                          claimRows, p.id),
                                        (row.override_linked_invoice_ids || []).includes(inv.id),
                                        !!showTaken[p.id]))
                                      .map(inv => {
                                        const selectedIds = row.override_linked_invoice_ids || []
                                        const isChecked = selectedIds.includes(inv.id)
                                        const remOwn = outstandingOwn(inv)
                                        const orderNum = isChecked ? selectedIds.indexOf(inv.id) + 1 : null
                                        // What other rows of this batch have left of it. The asking
                                        // row is excluded, so ticking an invoice never makes it look
                                        // unavailable to the row that just ticked it.
                                        const free = freeForRow(
                                          { id: inv.id, remaining: inv.remaining_rsd || 0 } as OpenInvoice,
                                          claimRows, p.id)
                                        const taken = free.exhausted && !isChecked
                                        const notice = claimNotice(free, claimRowLabel)
                                        return (
                                          <div key={inv.id}
                                            title={taken ? notice || undefined : undefined}
                                            style={{ padding: '7px 10px', borderRadius: '6px', border: isChecked ? '1.5px solid #00D47E' : '1px solid rgba(255,255,255,0.08)', background: isChecked ? 'rgba(0,212,126,0.08)' : 'rgba(255,255,255,0.03)', cursor: taken ? 'not-allowed' : 'pointer', opacity: taken ? 0.45 : 1, display: 'flex', gap: '8px', alignItems: 'flex-start' }}
                                            onClick={e => {
                                              e.stopPropagation()
                                              // Fully covered by another row in this batch. Ticking it
                                              // here would post nothing and leave some other invoice
                                              // open, which is the trap being closed.
                                              if (taken) return
                                              const newIds = isChecked
                                                ? selectedIds.filter(x => x !== inv.id)
                                                : [...selectedIds, inv.id]
                                              updateRow(p.id, {
                                                override_linked_invoice_ids: newIds,
                                                override_linked_invoice_id: newIds[0] || '',
                                                status: newIds.length > 0 ? 'accepted' as RowStatus : 'pending' as RowStatus
                                              })
                                            }}>
                                            <div style={{ width: '18px', height: '18px', borderRadius: '4px', border: `2px solid ${isChecked ? '#00D47E' : 'rgba(255,255,255,0.2)'}`, background: isChecked ? '#00D47E' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '1px', fontSize: '10px', color: '#060E1A', fontWeight: '700' }}>
                                              {isChecked ? orderNum : ''}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' as const }}>
                                                <span style={{ fontSize: '12px', fontWeight: '600', color: '#DCE9F6' }}>{inv.partner_name || '—'}</span>
                                                {inv.invoice_number && <span style={{ fontSize: '10px', color: '#7A9BB8', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '4px', fontFamily: 'monospace' }}>{inv.invoice_number}</span>}
                                              </div>
                                              <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '1px' }}>
                                                {inv.invoice_date}{inv.due_date ? ` · Dospeće: ${inv.due_date}` : ''}
                                              </div>
                                            </div>
                                            <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                                              <div style={{ fontSize: '11px', fontWeight: '600', color: '#DCE9F6' }}>{fmtMoney(inv.amount || 0, inv.currency || 'RSD')}</div>
                                              <div style={{ fontSize: '10px', color: remOwn > 0.01 ? '#FF5B5A' : '#00D47E', marginTop: '1px' }}>
                                                Preostalo: {fmtMoney(remOwn, inv.currency || 'RSD')}
                                              </div>
                                            </div>
                                          </div>
                                        )
                                    })}
                                  </div>
                                  {(row.override_linked_invoice_ids?.length > 0) && invoicePickerOpen[p.id] && (
                                    <button style={{ marginTop: '6px', fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 12px', border: '1px solid #00D47E', borderRadius: '6px', background: 'rgba(0,212,126,0.1)', color: '#00D47E', cursor: 'pointer', width: '100%' }}
                                      onClick={e => { e.stopPropagation(); setInvoicePickerOpen(prev => ({ ...prev, [p.id]: false })) }}>
                                      ✓ Potvrdi izbor ({countOf(row.override_linked_invoice_ids.length, 'faktura', 'fakture', 'faktura')})
                                    </button>
                                  )}
                                    </>
                                  )}
                                </div>
                              </div>
                              {(row.override_linked_invoice_ids?.length > 0) && (
                                <div style={{ ...s.aiNotes, background: DIALOG.blueFill, borderColor: DIALOG.blue, color: DIALOG.blue, marginTop: '8px' }}>
                                  💳 Zatvaraće redom {countOf(row.override_linked_invoice_ids.length, 'fakturu', 'fakture', 'faktura')} ·
                                  Ukupno preostalo: <strong>{fmtRSD(row.override_linked_invoice_ids.reduce((s, id) => { const inv = openInvoices.find(i => i.id === id); return s + (inv?.remaining_rsd || 0) }, 0))}</strong>
                                </div>

                              )}
                                {(() => {
                                  // An invoice indexed to another currency is
                                  // settled at a rate it was not raised at, so
                                  // it never lands exactly.
                                  const fx = fxForRow(row)
                                  if (!fx || !isBookable(fx.difference)) return null
                                  const script = fxScripts.find(sc => sc.id === row.override_fx_script_id)
                                    || findCurrencyDifference(fxScripts)
                                  return (
                                    <div style={s.fxBox} onClick={e => e.stopPropagation()}>
                                      <label style={s.fxHead}>
                                        <input type="checkbox" checked={row.override_fx_book}
                                          onChange={e => updateRow(p.id, { override_fx_book: e.target.checked })}
                                          style={{ accentColor: '#00D47E', cursor: 'pointer' }} />
                                        <span>
                                          Proknjiži {fx.difference.kind === 'gain' ? 'pozitivnu' : 'negativnu'} kursnu razliku od{' '}
                                          <strong>{formatMoney(fx.amountOwn, fx.currency)}</strong>
                                        </span>
                                      </label>
                                      <div style={s.fxNote}>{fx.difference.note}</div>
                                      {row.override_fx_book && (
                                        <>
                                          <select style={{ ...s.editSelect, width: '100%', marginTop: '8px' }}
                                            value={script?.id || ''}
                                            onChange={e => updateRow(p.id, { override_fx_script_id: e.target.value })}>
                                            {fxScripts.length === 0 && <option value="">Nema sačuvanih šablona</option>}
                                            {fxScripts.map(sc => (
                                              <option key={sc.id} value={sc.id}>{sc.name} — {sc.pl_category}</option>
                                            ))}
                                          </select>
                                          {!script && (
                                            <div style={{ ...s.fxNote, color: DIALOG.red }}>
                                              Nema šablona za kursne razlike, pa nema klasifikacije pod
                                              kojom bi se ovo proknjižilo.
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  )
                                })()}
                            </>
                          )}

                          {row.override_tx_type === 'direct' && row.override_tx_subtype === 'expense' && (
                            <>
                              {/* ONE BANK LINE, SEVERAL COSTS.
                                  Above the classification, because the first
                                  question is how many expenses this is — and
                                  if it is more than one, the fields below stop
                                  being the answer and become what the cash
                                  side reads instead. */}
                              <SplitEditor
                                parent={{
                                  amount: (p.debit || 0) > 0 ? (p.debit || 0) : (p.credit || 0),
                                  // The book figures are worked out at post
                                  // time from the official rate for the day.
                                  // The lines balance in the currency the bank
                                  // moved, which is the figure on screen.
                                  currency: p.currency || undefined,
                                }}
                                lines={row.override_pl_splits}
                                onChange={lines => {
                                  // The row's own classification follows the
                                  // biggest line: the ledger lists it, and a
                                  // row showing nothing under P&L Category
                                  // reads as one somebody forgot.
                                  const from = classificationFromSplit(lines)
                                  // The project moves between the row and its
                                  // lines by one rule — never on both at once.
                                  const moved = splitProjectChange(
                                    row.override_pl_splits, lines, projectIdFromInput(row.override_project_id))
                                  updateRow(p.id, {
                                    override_pl_splits: moved.lines,
                                    override_project_id: projectIdToInput(moved.parentProjectId),
                                    ...(from ? {
                                      override_pl_category_name: from.pl_category,
                                      override_pl_subcategory_name: from.pl_subcategory,
                                      override_department_name: from.department,
                                      override_dept_subcategory_name: from.dept_subcategory,
                                      override_expense_description: from.expense_description,
                                    } : {}),
                                  })
                                }}
                                companyId={company || null}
                                scripts={quickFillScripts as any}
                                classification={{ plCategories, plSubcategories, departments, deptSubcategories, expenseDescriptions }}
                                client={supabase}
                                onScriptsChanged={() => { fetchScripts(supabase).then(setQuickFillScripts as any) }}
                                hint="Jedna stavka izvoda, dva ili više troškova — svaki sa svojom klasifikacijom."
                              />

                              {row.override_pl_splits.length > 0 && (
                                <div style={{ fontSize: '11.5px', color: DIALOG.amber, margin: '2px 0 10px', lineHeight: 1.55 }}>
                                  Klasifikacija ispod je preuzeta iz najveće stavke podele i zaključana
                                  je dok podela postoji. P&amp;L čita podelu; ovo je ono pod čim glavna
                                  knjiga vodi stavku. Svaka stavka podele nosi svoj projekat.
                                </div>
                              )}
                              <div style={{
                                ...(row.override_pl_splits.length > 0
                                  ? { opacity: 0.5, pointerEvents: 'none' as const, userSelect: 'none' as const }
                                  : {}),
                              }}>
                              <div style={s.editSectionTitle}>P&L klasifikacija</div>
                              {/* Quick Fill */}
                              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
                                <div style={{ flex: 1, position: 'relative' as const }}>
                                  <div style={{ position: 'relative' as const }}>
                                    <input
                                      style={{ ...s.editInput, width: '100%', boxSizing: 'border-box' as const, border: `1px solid ${qfOpen === p.id ? '#00D47E' : 'rgba(0,212,126,0.3)'}`, background: 'rgba(0,212,126,0.05)', color: '#00D47E', fontSize: '12px', paddingRight: '28px' }}
                                      value={qfSearch}
                                      onChange={e => setQfSearch(e.target.value)}
                                      onFocus={() => setQfOpen(p.id)}
                                      onBlur={() => setTimeout(() => setQfOpen(null), 150)}
                                      placeholder="⚡ Brza popuna — kliknite ili pretražite…"
                                    />
                                    <span style={{ position: 'absolute' as const, right: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: '#00D47E', pointerEvents: 'none' as const }}>
                                      {qfOpen === p.id ? '▲' : '▼'}
                                    </span>
                                  </div>
                                  {qfOpen === p.id && (
                                    <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, background: '#111F30', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '8px', zIndex: 400, maxHeight: '220px', overflowY: 'auto' as const, marginTop: '2px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                                      {(() => {
                                        const filtered = quickFillScripts.filter(sc =>
                                          !qfSearch ||
                                          sc.name.toLowerCase().includes(qfSearch.toLowerCase()) ||
                                          sc.pl_category.toLowerCase().includes(qfSearch.toLowerCase()) ||
                                          sc.department.toLowerCase().includes(qfSearch.toLowerCase())
                                        )
                                        return filtered.length === 0
                                          ? <div style={{ padding: '10px 12px', fontSize: '12px', color: '#7A9BB8' }}>Nema rezultata za „{qfSearch}“</div>
                                          : filtered.map(sc => (
                                              <div key={sc.id}
                                                style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column' as const, gap: '2px' }}
                                                onMouseDown={e => {
                                                  e.preventDefault()
                                                  const matchCat = plCategories.find(c => c.name === sc.pl_category)
                                                  const matchDept = departments.find(d => d.name === sc.department)
                                                  const matchSub = plSubcategories.find(sub => sub.name === sc.pl_subcategory && sub.category_id === matchCat?.id)
                                                  // `sameName`, not `===`. An exact match falls through to the
                                                  // script's own text, so a script holding `Salary Expenses
                                                  // Domestic` wrote that literal string onto every transaction it
                                                  // filled — beside a lookup table that only ever held `Salary
                                                  // expenses domestic`. That is where the two spellings came from.
                                                  const matchDeptSub = deptSubcategories.find(sub => sameName(sub.name, sc.dept_subcategory) && sub.department_id === matchDept?.id)
                                                  updateRow(p.id, {
                                                    override_pl_category_id: matchCat?.id || '',
                                                    override_pl_category_name: matchCat?.name || sc.pl_category,
                                                    override_pl_subcategory_id: matchSub?.id || '',
                                                    override_pl_subcategory_name: matchSub?.name || sc.pl_subcategory,
                                                    override_department_id: matchDept?.id || '',
                                                    override_department_name: matchDept?.name || sc.department,
                                                    override_dept_subcategory_id: matchDeptSub?.id || '',
                                                    override_dept_subcategory_name: matchDeptSub?.name || sc.dept_subcategory,
                                                    override_expense_description: sc.expense_description,
                                                    override_cf_type: sc.cf_type,
                                                    status: 'accepted' as RowStatus,
                                                  })
                                                  setQfSearch(''); setQfOpen(null)
                                                }}>
                                                <span style={{ fontSize: '12px', fontWeight: '500', color: '#00D47E' }}>{sc.icon} {sc.name}</span>
                                                <span style={{ fontSize: '10px', color: '#7A9BB8' }}>{sc.pl_category}{sc.dept_subcategory ? ` · ${sc.dept_subcategory}` : ''}</span>
                                              </div>
                                            ))
                                      })()}
                                    </div>
                                  )}
                                </div>
                                <button
                                  style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '6px', background: 'rgba(0,212,126,0.08)', color: '#00D47E', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                                  onClick={e => { e.stopPropagation(); setQfEditing({ ...EMPTY_SCRIPT, id: `script_${Date.now()}` }); setQfDialogOpen(true) }}>
                                  + Novi
                                </button>
                                <button
                                  style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                                  onClick={e => { e.stopPropagation(); setQfEditing(null); setQfDialogOpen(true) }}>
                                  ✎ Izmeni
                                </button>
                              </div>
                              <div style={s.editGrid2}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>P&L kategorija</label>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                  <SearchableSelect value={row.override_pl_category_id}
                                    onChange={v => { const c = plCategories.find(x => x.id === v); updateRow(p.id, { override_pl_category_id: v, override_pl_category_name: c?.name || '', override_pl_subcategory_id: '', override_pl_subcategory_name: '' }) }}
                                    options={plCategories.map(c => ({ value: c.id, label: c.name }))}
                                    allLabel="Izaberite kategoriju…" searchPlaceholder="Pretraga kategorija…"
                                    style={pickerChrome} />
                                  <InlineCategoryAdd table="pl_categories"
                                    currentCount={plCategories.length}
                                    onAdded={item => { setPlCategories(prev => [...prev, { ...item, type: 'expense', sort_order: prev.length + 1 }]); updateRow(p.id, { override_pl_category_id: item.id, override_pl_category_name: item.name, override_pl_subcategory_id: '', override_pl_subcategory_name: '' }) }} />
                                  </div>
                                </div>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Potkategorija</label>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                  <SearchableSelect value={row.override_pl_subcategory_id}
                                    onChange={v => { const sub = plSubcategories.find(x => x.id === v); updateRow(p.id, { override_pl_subcategory_id: v, override_pl_subcategory_name: sub?.name || '' }) }}
                                    options={plSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                                    allLabel="Izaberite potkategoriju…" searchPlaceholder="Pretraga potkategorija…"
                                    disabled={!row.override_pl_category_id || plSubs.length === 0}
                                    style={pickerChrome} />
                                  <InlineCategoryAdd table="pl_subcategories" parentId={row.override_pl_category_id} parentField="category_id"
                                    currentCount={plSubs.length} disabled={!row.override_pl_category_id}
                                    onAdded={item => { setPlSubcategories(prev => [...prev, { ...item, category_id: row.override_pl_category_id, sort_order: prev.length + 1 }]); updateRow(p.id, { override_pl_subcategory_id: item.id, override_pl_subcategory_name: item.name }) }} />
                                  </div>
                                </div>
                              </div>
                              <div style={s.editSectionTitle}>Sektor</div>
                              <div style={s.editGrid2}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Sektor</label>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                  <SearchableSelect value={row.override_department_id}
                                    onChange={v => { const d = departments.find(x => x.id === v); updateRow(p.id, { override_department_id: v, override_department_name: d?.name || '', override_dept_subcategory_id: '', override_dept_subcategory_name: '', override_expense_description: '' }) }}
                                    options={departments.map(d => ({ value: d.id, label: d.name }))}
                                    allLabel="Izaberite sektor…" searchPlaceholder="Pretraga sektora…"
                                    style={pickerChrome} />
                                  <InlineCategoryAdd table="departments"
                                    currentCount={departments.length}
                                    onAdded={item => { setDepartments(prev => [...prev, { ...item, sort_order: prev.length + 1 }]); updateRow(p.id, { override_department_id: item.id, override_department_name: item.name, override_dept_subcategory_id: '', override_dept_subcategory_name: '', override_expense_description: '' }) }} />
                                  </div>
                                </div>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Podsektor</label>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                  <SearchableSelect value={row.override_dept_subcategory_id}
                                    onChange={v => { const sub = deptSubcategories.find(x => x.id === v); updateRow(p.id, { override_dept_subcategory_id: v, override_dept_subcategory_name: sub?.name || '', override_expense_description: '' }) }}
                                    options={deptSubs.map(sub => ({ value: sub.id, label: sub.name }))}
                                    allLabel="Izaberite potkategoriju…" searchPlaceholder="Pretraga potkategorija…"
                                    disabled={!row.override_department_id || deptSubs.length === 0}
                                    style={pickerChrome} />
                                  <InlineCategoryAdd table="dept_subcategories" parentId={row.override_department_id} parentField="department_id"
                                    currentCount={deptSubs.length} disabled={!row.override_department_id}
                                    onAdded={item => { setDeptSubcategories(prev => [...prev, { ...item, department_id: row.override_department_id, sort_order: prev.length + 1 }]); updateRow(p.id, { override_dept_subcategory_id: item.id, override_dept_subcategory_name: item.name, override_expense_description: '' }) }} />
                                  </div>
                                </div>
                              </div>
                              <div style={{ marginTop: '8px' }}>
                                <div style={s.editField}>
                                  <label style={s.editLbl}>Opis troška</label>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                                    {expDescs.length > 0 ? (
                                      <SearchableSelect value={row.override_expense_description}
                                        onChange={v => updateRow(p.id, { override_expense_description: v })}
                                        options={expDescs.map(d => ({ value: d.name, label: d.name }))}
                                        allLabel="Izaberite opis…" searchPlaceholder="Pretraga opisa…"
                                        style={{ ...pickerChrome, flex: 1 }} />
                                    ) : (
                                      <input style={{ ...s.editInput, flex: 1 }} value={row.override_expense_description} onChange={e => updateRow(p.id, { override_expense_description: e.target.value })} placeholder="npr. Telekom, AWS, zakup…" />
                                    )}
                                    <InlineCategoryAdd table="expense_descriptions" parentId={row.override_dept_subcategory_id} parentField="dept_subcategory_id"
                                      currentCount={expDescs.length} disabled={!row.override_dept_subcategory_id}
                                      onAdded={item => { setExpenseDescriptions(prev => [...prev, { ...item, dept_subcategory_id: row.override_dept_subcategory_id, sort_order: prev.length + 1 }]); updateRow(p.id, { override_expense_description: item.name }) }} />
                                  </div>
                                </div>
                              </div>
                              <div style={s.editSectionTitle}>Klasifikacija novčanog toka</div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '6px', marginTop: '6px' }}>
                                {[{ id: 'recurring', label: '🔁 Ponavljajući' }, { id: 'one_time', label: '1️⃣ Jednokratni' }, { id: 'accrual', label: '📅 Razgraničenje' }, { id: 'capex', label: '🏗 Kap. izdatak' }, { id: 'reimbursable', label: '↩️ Refund.' }].map(a => (
                                  <div key={a.id} style={{ ...s.allocBtn, padding: '6px 4px', ...(row.override_cf_type === a.id ? { border: '2px solid ' + DIALOG.accent, background: DIALOG.accentFill } : {}) }}
                                    onClick={() => updateRow(p.id, { override_cf_type: row.override_cf_type === a.id ? '' : a.id })}>
                                    <div style={{ fontSize: '10px', fontWeight: '600', color: row.override_cf_type === a.id ? DIALOG.accent : DIALOG.text }}>{a.label}</div>
                                  </div>
                                ))}
                              </div>
                              {row.override_cf_type === 'recurring' && (
                                <div style={{ marginTop: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
                                  <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                                    {[{ id: 'monthly', label: '📆 Mesečno' }, { id: 'quarterly', label: '📊 Kvartalno' }, { id: 'yearly', label: '📅 Godišnje' }].map(f => (
                                      <div key={f.id}
                                        style={{ flex: 1, padding: '7px', border: row.override_cf_frequency === f.id ? '2px solid #00D47E' : '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: row.override_cf_frequency === f.id ? 'rgba(0,212,126,0.10)' : 'transparent', cursor: 'pointer', textAlign: 'center' as const, fontSize: '11px', fontWeight: row.override_cf_frequency === f.id ? '600' : '400', color: row.override_cf_frequency === f.id ? '#00D47E' : '#7A9BB8' }}
                                        onClick={() => updateRow(p.id, { override_cf_frequency: f.id })}>
                                        {f.label}
                                      </div>
                                    ))}
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '4px' }}>
                                    <label style={s.editLbl}>Procena za sledeći mesec ({p.currency || '—'})</label>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                      <input
                                        type="number"
                                        style={{ ...s.editInput, flex: 1 }}
                                        value={row.override_cf_next_month_est}
                                        onChange={e => updateRow(p.id, { override_cf_next_month_est: e.target.value })}
                                        placeholder={`Automatski: ${fmtNum(p.debit || p.credit || 0)}`}
                                      />
                                      {!row.override_cf_next_month_est && (
                                        <button
                                          style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 10px', border: '1px solid rgba(0,212,126,0.3)', borderRadius: '6px', background: 'transparent', color: '#00D47E', cursor: 'pointer', whiteSpace: 'nowrap' as const }}
                                          onClick={() => updateRow(p.id, { override_cf_next_month_est: String(p.debit || p.credit || '') })}>
                                          Preuzmi ovaj iznos
                                        </button>
                                      )}
                                    </div>
                                    {(p.debit || p.credit) && (
                                      <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px' }}>
                                        Automatski: {row.override_cf_frequency === 'quarterly'
                                          ? fmtNum((p.debit || p.credit || 0) / 3)
                                          : row.override_cf_frequency === 'yearly'
                                          ? fmtNum((p.debit || p.credit || 0) / 12)
                                          : fmtNum(p.debit || p.credit || 0)} {p.currency}/mes.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                              </div>
                            </>
                          )}

                          {row.override_tx_type === 'direct' && row.override_tx_subtype === 'revenue' && (
                            <div style={{ marginTop: '8px' }}>
                              <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '12px', marginBottom: '8px' }}>
                                <input type="checkbox" checked={!!row.override_is_advance}
                                  onChange={e => updateRow(p.id, { override_is_advance: e.target.checked })}
                                  style={{ accentColor: DIALOG.accent, cursor: 'pointer', marginTop: '2px' }} />
                                <span>
                                  <strong>{ADVANCE_LABEL}</strong> — primljen od investitora
                                  <span style={{ display: 'block', fontSize: '10.5px', color: DIALOG.dim, lineHeight: 1.4 }}>
                                    Obaveza, ne prihod: bez uticaja na bilans uspeha, obavezno na projektu, bez podele i bez povezivanja sa fakturom.
                                  </span>
                                </span>
                              </label>
                              {effectiveAdvance(row.override_tx_type, row.override_tx_subtype, row.override_is_advance) && !projectIdFromInput(row.override_project_id) && (
                                <div style={{ fontSize: '11px', color: DIALOG.red, marginBottom: '8px' }}>
                                  Avans mora biti na projektu — izaberite projekat ispod.
                                </div>
                              )}
                              {(() => {
                                const hint = doubleCountHint(
                                  { type: row.override_tx_type, subtype: row.override_tx_subtype, isAdvance: row.override_is_advance },
                                  row.override_partner_id || null, openInvoices)
                                return hint ? (
                                  <div style={{ fontSize: '11px', color: DIALOG.amber, background: DIALOG.amberFill, borderRadius: '6px', padding: '6px 8px', marginBottom: '8px', lineHeight: 1.5 }}>
                                    {hint}{' '}
                                    <span style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}
                                      onClick={() => updateRow(p.id, { override_tx_type: 'invoice_payment', override_is_advance: false })}>Prebaci na plaćanje fakture</span>
                                  </div>
                                ) : null
                              })()}
                              <div style={s.editField}>
                                <label style={s.editLbl}>Vrsta prihoda</label>
                                <select style={s.editSelect} value={row.override_revenue_stream} onChange={e => updateRow(p.id, { override_revenue_stream: e.target.value })}>
                                  <option value="">Izaberite vrstu prihoda…</option>
                                  {REVENUE_STREAMS.map(r => <option key={r}>{r}</option>)}
                                </select>
                              </div>
                            </div>
                          )}

                          {/* Project — one per line; a split line's are on its parts. */}
                          {row.override_tx_type === 'direct' && row.override_pl_splits.length === 0 && (
                            <div style={{ marginTop: '8px' }}>
                              <div style={s.editField}>
                                <label style={s.editLbl}>Projekat</label>
                                <ProjectSelect
                                  value={projectIdFromInput(row.override_project_id)}
                                  onChange={id => updateRow(p.id, { override_project_id: projectIdToInput(id) })}
                                  companyId={company || null}
                                  style={pickerChrome} />
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px', gap: '6px' }}>
                            <button style={s.btnSmallRed} onClick={() => rejectRow(p.id)}>✕ Odbij</button>
                            <button style={s.btnSmallGreen} onClick={() => { acceptRow(p.id); toggleExpand(p.id) }}>✓ Prihvati i zatvori</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div style={s.footer}>
          {step === 'upload' && (
            <>
              <span style={{ fontSize: '12px', color: DIALOG.dim }}>{rows.length > 0 ? `Spremno stavki: ${rows.length}` : 'Otpremite fajl da biste počeli'}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button style={s.btnGhost} onClick={onClose}>Otkaži</button>
                <button style={{ ...s.btnGhost, opacity: (!company || !bank || rows.length === 0 || analyzing) ? 0.5 : 1 }}
                  onClick={() => { if (company && bank && rows.length > 0) { setRows(prev => prev.map(r => r.already_imported ? r : ({ ...r, status: 'pending' as RowStatus }))); setStep('review') } }}
                  disabled={!company || !bank || rows.length === 0 || analyzing}>
                  📋 Bez AI — pregledaj ručno
                </button>
                <button style={{ ...s.btnPrimary, opacity: (!company || !bank || rows.length === 0 || analyzing) ? 0.5 : 1 }}
                  onClick={analyzeWithAI} disabled={!company || !bank || rows.length === 0 || analyzing}>
                  {analyzing ? `🤖 Analiza… ${progress}%` : '🤖 Analiziraj uz AI'}
                </button>
              </div>
            </>
          )}
          {step === 'review' && (
            <>
              <span style={{ fontSize: '12px', color: DIALOG.dim }}>Biće proknjiženo stavki: {accepted}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button style={s.btnGhost} onClick={() => setStep('upload')}>← Nazad</button>
                <button style={{ ...s.btnPrimary, opacity: accepted === 0 ? 0.5 : 1 }} onClick={postAccepted} disabled={accepted === 0}>
                  Proknjiži ({accepted})
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Quick Fill Script Manager Dialog */}
      {qfDialogOpen && (
        <div style={{ position: 'fixed', inset: 0, background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}
          onClick={() => setQfDialogOpen(false)}>
          <div style={{ background: '#0D1B2C', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '14px', width: '680px', maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ background: '#060E1A', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ color: '#DCE9F6', fontSize: '14px', fontWeight: '500' }}>
                {qfEditing && qfEditing.name === '' ? '➕ Novi šablon' : qfEditing ? `✎ Izmena: ${qfEditing.name}` : '⚡ Šabloni za brzu popunu'}
              </div>
              <button style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: '20px', cursor: 'pointer' }} onClick={() => { setQfDialogOpen(false); setQfEditing(null) }}>×</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' as const, padding: '16px 20px' }}>
              {qfEditing ? (
                /* Edit / New form */
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '12px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Ikona</div>
                      <input style={{ ...s.editInput, textAlign: 'center' as const, fontSize: '20px' }} value={qfEditing.icon} onChange={e => setQfEditing({ ...qfEditing, icon: e.target.value })} />
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Naziv šablona *</div>
                      <input style={s.editInput} value={qfEditing.name} onChange={e => setQfEditing({ ...qfEditing, name: e.target.value })} placeholder="npr. Bankarska provizija — domaća" />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>P&L kategorija</div>
                      <select style={s.editSelect} value={qfEditing.pl_category} onChange={e => setQfEditing({ ...qfEditing, pl_category: e.target.value, pl_subcategory: '' })}>
                        <option value="">Izaberite…</option>
                        {plCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Potkategorija</div>
                      <select style={s.editSelect} value={qfEditing.pl_subcategory} onChange={e => setQfEditing({ ...qfEditing, pl_subcategory: e.target.value })}>
                        <option value="">Izaberite…</option>
                        {plSubcategories.filter(sub => { const cat = plCategories.find(c => c.name === qfEditing.pl_category); return cat && sub.category_id === cat.id }).map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Sektor</div>
                      <select style={s.editSelect} value={qfEditing.department} onChange={e => setQfEditing({ ...qfEditing, department: e.target.value, dept_subcategory: '', expense_description: '' })}>
                        <option value="">Izaberite…</option>
                        {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Podsektor</div>
                      <select style={s.editSelect} value={qfEditing.dept_subcategory} onChange={e => setQfEditing({ ...qfEditing, dept_subcategory: e.target.value, expense_description: '' })}>
                        <option value="">Izaberite…</option>
                        {deptSubcategories.filter(sub => { const dept = departments.find(d => d.name === qfEditing.department); return dept && sub.department_id === dept.id }).map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Opis troška</div>
                    {(() => {
                      // Match dept_subcategory by BOTH name AND parent department to avoid cross-dept collisions
                      const parentDept = departments.find(d => d.name === qfEditing.department)
                      const deptSub = deptSubcategories.find(sub =>
                        sub.name === qfEditing.dept_subcategory &&
                        sub.department_id === parentDept?.id
                      )
                      const descs = deptSub ? expenseDescriptions.filter(ed => ed.dept_subcategory_id === deptSub.id) : []
                      return descs.length > 0
                        ? <select style={s.editSelect} value={qfEditing.expense_description} onChange={e => setQfEditing({ ...qfEditing, expense_description: e.target.value })}>
                            <option value="">Izaberite…</option>
                            {descs.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                          </select>
                        : <input style={s.editInput} value={qfEditing.expense_description} onChange={e => setQfEditing({ ...qfEditing, expense_description: e.target.value })} placeholder="npr. AWS, Telekom…" />
                    })()}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', textTransform: 'uppercase' as const }}>Tip novčanog toka</div>
                      <select style={s.editSelect} value={qfEditing.cf_type} onChange={e => setQfEditing({ ...qfEditing, cf_type: e.target.value })}>
                        <option value="recurring">Ponavljajući</option>
                        <option value="one_time">Jednokratni</option>
                        <option value="accrual">Razgraničenje</option>
                        <option value="capex">Kapitalni izdatak</option>
                        <option value="">— Bez —</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 16px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}
                      onClick={() => setQfEditing(null)}>← Nazad</button>
                    <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '7px 16px', border: 'none', borderRadius: '8px', background: '#00D47E', color: '#060E1A', cursor: 'pointer', fontWeight: '600', opacity: !qfEditing.name.trim() ? 0.5 : 1 }}
                      disabled={!qfEditing.name.trim()}
                      onClick={async () => {
                        const exists = quickFillScripts.some(sc => sc.id === qfEditing.id)
                        if (await persistScript(exists ? qfEditing : { ...qfEditing, id: undefined as any })) {
                          setQfEditing(null)
                        }
                      }}>
                      ✓ Sačuvaj šablon
                    </button>
                  </div>
                </div>
              ) : (
                /* Script list */
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                  {quickFillScripts.map(sc => (
                    <div key={sc.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '8px' }}>
                      <span style={{ fontSize: '18px', width: '28px', textAlign: 'center' as const }}>{sc.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: '500', color: '#DCE9F6' }}>{sc.name}</div>
                        <div style={{ fontSize: '10px', color: '#7A9BB8', marginTop: '2px' }}>
                          {sc.pl_category}{sc.pl_subcategory ? ` › ${sc.pl_subcategory}` : ''} · {sc.department}{sc.dept_subcategory ? ` › ${sc.dept_subcategory}` : ''}
                          {sc.expense_description ? ` · ${sc.expense_description}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' }}
                          onClick={() => setQfEditing(sc)}>✎ Izmeni</button>
                        <button style={{ fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '4px 10px', border: '1px solid rgba(255,91,90,0.3)', borderRadius: '6px', background: 'transparent', color: '#FF5B5A', cursor: 'pointer' }}
                          onClick={() => { if (window.confirm(`Obrisati „${sc.name}“?\n\nŠablon je zajednički, pa se briše za sve. Stavke koje su već razvrstane njime zadržavaju klasifikaciju.`)) removeScriptById(sc.id) }}>✕</button>
                      </div>
                    </div>
                  ))}
                  <button style={{ marginTop: '8px', fontFamily: 'system-ui,sans-serif', fontSize: '12px', padding: '8px', border: '1px dashed rgba(0,212,126,0.3)', borderRadius: '8px', background: 'transparent', color: '#00D47E', cursor: 'pointer', width: '100%' }}
                    onClick={() => setQfEditing({ ...EMPTY_SCRIPT, id: `script_${Date.now()}` })}>
                    + Dodaj šablon
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {partnerDialogRow && (
        <PartnerDialog
          initialName={partnerDialogRow.initialName}
          initialAccountNumber={partnerDialogRow.initialAccount}
          onClose={() => setPartnerDialogRow(null)}
          onSaved={(newPartner) => {
            setPartners(prev => [...prev, newPartner])
            supabase.from('partner_accounts').select('id,partner_id,account_number,bank_name,is_primary')
              .eq('partner_id', newPartner.id)
              .then(({ data }) => { if (data) setPartnerAccounts(prev => [...prev, ...data]) })
            const rowId = partnerDialogRow.rowId
            updateRow(rowId, { override_partner_name: newPartner.name, override_partner_id: newPartner.id })
            setReviewPartnerSearch(prev => ({ ...prev, [rowId]: newPartner.name }))
            setPartnerDialogRow(null)
          }}
        />
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, colorScheme: 'dark', background: DIALOG.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: DIALOG.z },
  dialog: { background: '#0D1B2C', borderRadius: '16px', width: '920px', maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { background: '#060E1A', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: DIALOG.text, fontSize: '15px', fontWeight: '500', marginBottom: '3px' },
  headerSub: { color: 'rgba(255,255,255,0.45)', fontSize: '12px' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: '22px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  body: { padding: '1.5rem', overflowY: 'auto', flex: 1, background: '#0D1B2C' },
  footer: { padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#060E1A' },
  section: { marginBottom: '1.5rem' },
  sectionTitle: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  lbl: { fontSize: '11px', fontWeight: '500', color: DIALOG.dim, textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  req: { color: DIALOG.red },
  select: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  dropZone: { border: '2px dashed rgba(255,255,255,0.12)', borderRadius: '12px', padding: '2.5rem', textAlign: 'center' as const, cursor: 'pointer', background: 'rgba(255,255,255,0.02)' },
  infoBox: { background: 'rgba(0,212,126,0.08)', border: '1px solid rgba(0,212,126,0.25)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#00D47E', marginBottom: '12px' },
  errorMsg: { fontSize: '12px', color: DIALOG.red, marginTop: '8px' },
  previewList: { border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', overflow: 'hidden' },
  previewRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: '#111F30' },
  analyzingBox: { background: DIALOG.accentFill, border: '0.5px solid ' + DIALOG.accent, borderRadius: '10px', padding: '16px', textAlign: 'center' as const },
  progressBar: { width: '100%', height: '6px', background: DIALOG.border, borderRadius: '3px', overflow: 'hidden' },
  progressFill: { height: '100%', background: DIALOG.accent, borderRadius: '3px' },
  reviewSummary: { display: 'flex', alignItems: 'center', gap: '24px', padding: '12px 16px', background: '#111F30', borderRadius: '10px', marginBottom: '12px', border: '1px solid rgba(255,255,255,0.07)' },
  reviewStat: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '2px' },
  reviewList: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  reviewRow: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', background: '#0D1B2C', overflow: 'visible' },
  reviewRowAccepted: { border: '1.5px solid #00D47E', background: 'rgba(0,212,126,0.06)' },
  reviewRowRejected: { opacity: 0.45 },
  reviewRowPassthrough: { border: '1px solid rgba(245,166,35,0.4)', background: 'rgba(245,166,35,0.05)' },
  reviewRowMain: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', cursor: 'pointer', background: '#111F30', borderRadius: '10px 10px 0 0' },
  editPanel: { padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.07)', background: '#0D1B2C' },
  aiNotes: { fontSize: '11px', color: '#00D47E', background: 'rgba(0,212,126,0.08)', border: '1px solid rgba(0,212,126,0.2)', borderRadius: '6px', padding: '6px 10px', marginBottom: '12px' },
  editSectionTitle: { fontSize: '10px', fontWeight: '600', color: '#7A9BB8', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginTop: '14px', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
  editGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  editField: { display: 'flex', flexDirection: 'column' as const, gap: '4px' },
  editLbl: { fontSize: '10px', fontWeight: '500', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' as const, letterSpacing: '0.07em' },
  editInput: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  editSelect: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', background: '#111F30', color: '#DCE9F6', outline: 'none' },
  fxBox: {
    marginTop: '8px', padding: '9px 12px', borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)',
  },
  fxHead: {
    display: 'flex', alignItems: 'flex-start', gap: '8px',
    fontSize: '12px', color: '#DCE9F6', lineHeight: 1.5, cursor: 'pointer',
  },
  fxNote: { fontSize: '10.5px', color: '#7A9BB8', lineHeight: 1.5, marginTop: '6px' },
  allocGrid: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', marginTop: '6px' },
  allocBtn: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 6px', background: 'rgba(255,255,255,0.03)', cursor: 'pointer', textAlign: 'center' as const },
  allocBtnActive: { border: '2px solid #00D47E', background: 'rgba(0,212,126,0.10)' },
  actionBtn: { width: '28px', height: '28px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', cursor: 'pointer', fontSize: '12px', color: '#7A9BB8', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  actionBtnAccepted: { background: 'rgba(0,212,126,0.15)', border: '1.5px solid #00D47E', color: '#00D47E' },
  actionBtnRejected: { background: 'rgba(255,91,90,0.12)', border: '1.5px solid #FF5B5A', color: '#FF5B5A' },
  btnSmallGreen: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 12px', border: '0.5px solid ' + DIALOG.accent, borderRadius: '6px', background: 'transparent', color: DIALOG.accent, cursor: 'pointer' },
  btnSmallRed: { fontFamily: 'system-ui,sans-serif', fontSize: '11px', padding: '5px 12px', border: '0.5px solid ' + DIALOG.red, borderRadius: '6px', background: 'transparent', color: DIALOG.red, cursor: 'pointer' },
  btnGhost: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', color: '#7A9BB8', cursor: 'pointer' },
  btnPrimary: { fontFamily: 'system-ui,sans-serif', fontSize: '13px', padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#00D47E', color: '#060E1A', cursor: 'pointer', fontWeight: '600' },
}

// `SearchableSelect` paints its border with longhands so it can recolour just
// the edge when the list opens, and React warns about mixing those with the
// `border` shorthand on one element. So the shorthand is dropped here and the
// control keeps its own border, which is the same weight and colour.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { border: _pickerBorder, ...pickerChrome } = s.editSelect
