import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'

// AuthContext i stranice zovu supabase pri montiranju. Mock drzi test offline
// i deterministicnim — bez njega test zavisi od mreze i od stanja baze.
//
// Query builder se pravi kao Proxy koji na bilo koji metod vraca sam sebe i
// koji je istovremeno "thenable". Time mock pokriva svaki lanac (.select()
// .eq() .order() .limit() .single() …) bez nabrajanja pojedinacnih metoda.
jest.mock('./supabase', () => {
  const makeBuilder = (): any => {
    const result = { data: [], error: null, count: 0 }
    const target: any = {
      then: (resolve: any) => Promise.resolve(result).then(resolve),
      catch: (reject: any) => Promise.resolve(result).catch(reject),
      finally: (cb: any) => Promise.resolve(result).finally(cb),
    }
    return new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop as keyof typeof obj]
        return () => makeBuilder()
      },
    })
  }

  // VAZNO: obicne funkcije, ne jest.fn().mockResolvedValue(). CRA postavlja
  // `resetMocks: true`, sto prije svakog testa brise implementacije zadate
  // preko mockResolvedValue — pa bi getSession() vracao undefined.
  return {
    supabase: {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe: () => {} } },
        }),
        signOut: () => Promise.resolve({}),
      },
      from: () => makeBuilder(),
    },
  }
})

describe('App', () => {
  it('shows the sign-in screen to a signed-out user', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/sign in to your mcflow account/i)).toBeInTheDocument()
  })

  it('does not show navigation to a signed-out user', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument()
    })
    // The sidebar must not appear before sign-in.
    expect(screen.queryByText(/bank credits/i)).not.toBeInTheDocument()
  })
})
