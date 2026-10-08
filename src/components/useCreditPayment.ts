import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export interface CreditOption {
  id: string
  name: string
  bank: string
  rate_description: string
  /**
   * The credit's own currency, which every instalment figure is in. A loan
   * may be indexed to EUR or taken in RSD; a payment booked against it goes
   * through the ordinary book-amount rules from this currency.
   */
  currency: string
}

export interface CreditInstallment {
  id: string
  installment_no: number
  due_date: string
  principal_amount: number
  interest_amount: number
  total_amount: number
  status: string
  paid_amount?: number | null
}

export function useCreditPayment() {
  const [credits, setCredits] = useState<CreditOption[]>([])
  const [selectedCreditId, setSelectedCreditId] = useState('')
  const [creditInstallments, setCreditInstallments] = useState<CreditInstallment[]>([])
  const [selectedInstallmentIds, setSelectedInstallmentIds] = useState<string[]>([])

  useEffect(() => {
    supabase
      .from('credits')
      .select('id, name, bank, rate_description, currency')
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => {
        if (data) setCredits(data.map((c: any) => ({ ...c, currency: c.currency || 'RSD' })))
      })
  }, [])

  useEffect(() => {
    if (!selectedCreditId) { setCreditInstallments([]); setSelectedInstallmentIds([]); return }
    supabase
      .from('credit_installments')
      .select('id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, paid_amount')
      .eq('credit_id', selectedCreditId)
      .eq('status', 'outstanding')
      .order('due_date')
      .then(({ data }) => {
        if (data) {
          setCreditInstallments(data)
          // Auto-select first outstanding installment
          if (data.length > 0) setSelectedInstallmentIds([data[0].id])
        }
      })
  }, [selectedCreditId])

  const toggleInstallment = (id: string) =>
    setSelectedInstallmentIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )

  const toggleAll = () =>
    setSelectedInstallmentIds(prev =>
      prev.length === creditInstallments.length ? [] : creditInstallments.map(i => i.id)
    )

  const selectedTotal = creditInstallments
    .filter(i => selectedInstallmentIds.includes(i.id))
    .reduce((s, i) => s + i.total_amount, 0)

  /** The selected credit's currency — what `selectedTotal` and every instalment are in. */
  const selectedCurrency = credits.find(c => c.id === selectedCreditId)?.currency || null

  const reset = () => {
    setSelectedCreditId('')
    setCreditInstallments([])
    setSelectedInstallmentIds([])
  }

  return {
    credits, selectedCreditId, setSelectedCreditId,
    creditInstallments, selectedInstallmentIds,
    toggleInstallment, toggleAll, selectedTotal, selectedCurrency, reset,
  }
}

export async function closeCreditInstallments(
  txId: string,
  txDate: string,
  selectedInstallmentIds: string[],
  selectedCreditId: string
) {
  if (!selectedInstallmentIds.length) return
  await supabase
    .from('credit_installments')
    .update({ status: 'paid', paid_date: txDate, transaction_id: txId, updated_at: new Date().toISOString() })
    .in('id', selectedInstallmentIds)
  if (selectedCreditId) {
    const { data: remaining } = await supabase
      .from('credit_installments').select('id')
      .eq('credit_id', selectedCreditId).eq('status', 'outstanding')
    if (remaining && remaining.length === 0)
      await supabase.from('credits')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('id', selectedCreditId)
  }
}
