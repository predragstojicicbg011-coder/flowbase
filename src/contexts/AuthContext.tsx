import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { User } from '@supabase/supabase-js'

export type UserRole = 'administrator' | 'owner' | 'manager' | 'administrative_assistant'

export interface UserProfile {
  id: string
  full_name: string | null
  email: string | null
  role: UserRole
  company_access: string[]
}

interface AuthContextType {
  user: User | null
  profile: UserProfile | null
  role: UserRole | null
  loading: boolean
  signOut: () => Promise<void>
  // Permission helpers
  canEdit: boolean       // administrator, owner, administrative_assistant
  canDelete: boolean     // administrator, owner
  canViewReports: boolean // all roles
  canManageSettings: boolean // administrator only
  canManageUsers: boolean    // administrator only
  hasCompanyAccess: (companyId: string) => boolean
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  role: null,
  loading: true,
  signOut: async () => {},
  canEdit: false,
  canDelete: false,
  canViewReports: true,
  canManageSettings: false,
  canManageUsers: false,
  hasCompanyAccess: () => false,
  refreshProfile: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (data) {
      setProfile({
        id: data.id,
        full_name: data.full_name,
        email: data.email,
        role: data.role || 'administrative_assistant',
        company_access: data.company_access || [],
      })
    }
  }

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) fetchProfile(u.id).finally(() => setLoading(false))
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) fetchProfile(u.id)
      else setProfile(null)
    })

    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }

  const role = profile?.role ?? null

  // ── Permission helpers ──────────────────────────────────
  const canEdit = role !== null && role !== 'manager'
  const canDelete = role === 'administrator' || role === 'owner'
  const canViewReports = true
  const canManageSettings = role === 'administrator'
  const canManageUsers = role === 'administrator'

  const hasCompanyAccess = (companyId: string): boolean => {
    if (!profile) return false
    if (role === 'administrator' || role === 'owner') return true
    return profile.company_access.includes(companyId)
  }

  return (
    <AuthContext.Provider value={{
      user, profile, role, loading, signOut,
      canEdit, canDelete, canViewReports,
      canManageSettings, canManageUsers,
      hasCompanyAccess, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)