import React, { createContext, useContext, useState, useCallback } from 'react'

type DataKey = 'credits' | 'transactions' | 'invoices' | 'all'

interface DataRefreshContextType {
  // Increment version to trigger refetch in listeners
  versions: Record<DataKey, number>
  invalidate: (key: DataKey) => void
}

const DataRefreshContext = createContext<DataRefreshContextType>({
  versions: { credits: 0, transactions: 0, invoices: 0, all: 0 },
  invalidate: () => {},
})

export function DataRefreshProvider({ children }: { children: React.ReactNode }) {
  const [versions, setVersions] = useState<Record<DataKey, number>>({
    credits: 0, transactions: 0, invoices: 0, all: 0,
  })

  const invalidate = useCallback((key: DataKey) => {
    setVersions(prev => ({
      ...prev,
      [key]: prev[key] + 1,
      all: prev.all + 1,
    }))
  }, [])

  return (
    <DataRefreshContext.Provider value={{ versions, invalidate }}>
      {children}
    </DataRefreshContext.Provider>
  )
}

export function useDataRefresh() {
  return useContext(DataRefreshContext)
}
