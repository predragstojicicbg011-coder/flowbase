import React from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { DataRefreshProvider } from './contexts/DataRefreshContext'
import { CompaniesProvider } from './contexts/CompaniesContext'
import { ProjectsProvider } from './contexts/ProjectsContext'
import { SystemCategoriesProvider } from './contexts/SystemCategoriesContext'
import { DisplayCurrencyProvider } from './contexts/DisplayCurrencyContext'
import { brand } from './config/brand'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import Revenue from './pages/Revenue'
import CashFlow from './pages/CashFlow'
import Budgeting from './pages/Budgeting'
import Reports from './pages/Reports'
import ExpenseAnalysis from './pages/ExpenseAnalysis'
import Partners from './pages/Partners'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Credits from './pages/Credits'
import HR from './pages/HR'
import Payroll from './pages/Payroll'
import Sidebar from './components/Sidebar'

// Navigacija je preseljena u ./navigation (URL je izvor istine).
// Re-export da postojeci importi `import type { Page } from '../App'` i dalje rade.
export type { Page } from './navigation'

function AppContent() {
  const { user, loading } = useAuth()

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: "'Inter', system-ui, sans-serif", color: '#888' }}>
      Učitavanje {brand.appName}…
    </div>
  )

  if (!user) return <Login />

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--page-bg)' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          <Route path="/dashboard"    element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/revenue"      element={<Revenue />} />
          <Route path="/cashflow"     element={<CashFlow />} />
          <Route path="/budgeting"    element={<Budgeting />} />
          <Route path="/reports"      element={<Reports />} />
          <Route path="/expenses"     element={<ExpenseAnalysis />} />
          {/* The P&L page's two analyses live on /expenses now, and the page
              itself is gone. Anyone holding a link or a bookmark to it lands
              on the report that replaced it rather than on the dashboard. */}
          <Route path="/pl"           element={<Navigate to="/expenses" replace />} />
          <Route path="/projects"     element={<Projects />} />
          <Route path="/partners"     element={<Partners />} />
          <Route path="/credits"      element={<Credits />} />
          <Route path="/hr"           element={<HR />} />
          <Route path="/payroll"      element={<Payroll />} />
          <Route path="/settings"     element={<Settings />} />
          <Route path="*"             element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function App() {
  // HashRouter: URL-ovi su oblika /#/transactions. Rade bez ikakve konfiguracije
  // servera — refresh i deep link nikad ne daju 404, i na statickom hostingu.
  return (
    <HashRouter>
      <AuthProvider>
        <CompaniesProvider>
          <ProjectsProvider>
            <SystemCategoriesProvider>
              <DataRefreshProvider>
                <DisplayCurrencyProvider>
                  <AppContent />
                </DisplayCurrencyProvider>
              </DataRefreshProvider>
            </SystemCategoriesProvider>
          </ProjectsProvider>
        </CompaniesProvider>
      </AuthProvider>
    </HashRouter>
  )
}

export default App
