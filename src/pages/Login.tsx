import React, { useState } from 'react'
import { supabase } from '../supabase'
import { brand } from '../config/brand'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPw, setShowPw] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(
      /invalid login credentials/i.test(error.message)
        ? 'Pogrešan email ili lozinka. Proverite podatke i pokušajte ponovo.'
        : `Prijava nije uspela: ${error.message}`,
    )
    setLoading(false)
  }

  return (
    <div style={styles.root}>
      <div style={styles.left}>
        <div style={styles.logoWrap}>
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <polygon points="18,2 34,30 2,30" fill="none" stroke="#1D9E75" strokeWidth="1.5"/>
            <circle cx="18" cy="2" r="2" fill="#1D9E75"/>
            <circle cx="34" cy="30" r="2" fill="#5DCAA5"/>
            <circle cx="2" cy="30" r="2" fill="#9FE1CB"/>
          </svg>
          <div>
            <div style={styles.logoText}>{brand.logo[0]}<span style={styles.logoAccent}>{brand.logo[1]}</span></div>
            <div style={styles.logoSub}>{brand.companyShort}</div>
          </div>
        </div>
        <div style={styles.heroWrap}>
          <div style={styles.heroTitle}>Pratite<br/>finansije <span style={styles.heroAccent}>jasno</span><br/>i na vreme.</div>
          <div style={styles.heroDesc}>{brand.tagline}</div>
        </div>
      </div>

      <div style={styles.right}>
        <div style={styles.badge}>
          <div style={styles.badgeDot}/>
          {brand.companyShort}
        </div>
        <div style={styles.formTitle}>Dobro došli</div>
        <div style={styles.formSub}>Prijavite se na svoj {brand.appName} nalog</div>

        {error && <div style={styles.errorBox}>{error}</div>}

        <form onSubmit={handleLogin}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Email adresa</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="vas@email.com"
              style={styles.input}
              required
            />
          </div>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Lozinka</label>
            <div style={styles.pwWrap}>
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{...styles.input, paddingRight: '60px'}}
                required
              />
              <button type="button" onClick={() => setShowPw(!showPw)} style={styles.pwBtn}>
                {showPw ? 'sakrij' : 'prikaži'}
              </button>
            </div>
          </div>
          <button type="submit" style={styles.submitBtn} disabled={loading}>
            {loading ? 'Prijavljivanje…' : 'Prijavi se'}
          </button>
        </form>

        <div style={styles.footer}>
          <span style={styles.version}>v1.0.0 — {brand.appName}</span>
          <span style={styles.secure}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{marginRight:4}}>
              <path d="M6 1L10 3V6.5C10 8.5 8 10.5 6 11C4 10.5 2 8.5 2 6.5V3L6 1Z" stroke="#1D9E75" strokeWidth="1" fill="none"/>
              <path d="M4 6L5.5 7.5L8 4.5" stroke="#1D9E75" strokeWidth="1" strokeLinecap="round"/>
            </svg>
            Zaštićena veza
          </span>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display:'flex', minHeight:'100vh', fontFamily:'system-ui,sans-serif' },
  left: { width:'45%', background:'#0a1628', display:'flex', flexDirection:'column', justifyContent:'space-between', padding:'3rem 2.5rem' },
  logoWrap: { display:'flex', alignItems:'center', gap:'10px' },
  logoText: { fontFamily:'Georgia,serif', fontSize:'22px', fontWeight:'500', color:'#fff', letterSpacing:'0.02em' },
  logoAccent: { color:'#1D9E75' },
  logoSub: { fontSize:'10px', color:'rgba(255,255,255,0.4)', textTransform:'uppercase', letterSpacing:'0.12em', marginTop:'2px' },
  heroWrap: { flex:1, display:'flex', flexDirection:'column', justifyContent:'center', padding:'2rem 0' },
  heroTitle: { fontFamily:'Georgia,serif', fontSize:'32px', fontWeight:'400', color:'#fff', lineHeight:1.3, marginBottom:'1rem' },
  heroAccent: { color:'#1D9E75' },
  heroDesc: { fontSize:'13px', color:'rgba(255,255,255,0.45)', lineHeight:1.7, fontWeight:'300', maxWidth:'260px' },
  right: { width:'55%', background:'#fff', display:'flex', flexDirection:'column', justifyContent:'center', padding:'3rem 3.5rem' },
  badge: { display:'inline-flex', alignItems:'center', gap:'6px', background:'#E1F5EE', color:'#0F6E56', fontSize:'11px', fontWeight:'500', padding:'4px 12px', borderRadius:'20px', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:'1.5rem', width:'fit-content' },
  badgeDot: { width:'6px', height:'6px', borderRadius:'50%', background:'#1D9E75' },
  formTitle: { fontFamily:'Georgia,serif', fontSize:'26px', fontWeight:'400', color:'#111', marginBottom:'0.4rem' },
  formSub: { fontSize:'13px', color:'#888', marginBottom:'2rem', fontWeight:'300' },
  errorBox: { background:'#FCEBEB', border:'0.5px solid #F09595', borderRadius:'8px', padding:'10px 14px', fontSize:'13px', color:'#A32D2D', marginBottom:'1rem' },
  fieldGroup: { marginBottom:'1rem' },
  label: { display:'block', fontSize:'11px', fontWeight:'500', color:'#888', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'6px' },
  input: { width:'100%', border:'0.5px solid #ddd', borderRadius:'8px', padding:'10px 14px', fontFamily:'system-ui,sans-serif', fontSize:'14px', color:'#111', background:'#fff', outline:'none', boxSizing:'border-box' },
  pwWrap: { position:'relative' },
  pwBtn: { position:'absolute', right:'12px', top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'#888', fontSize:'13px', padding:'2px' },
  submitBtn: { width:'100%', background:'#1D9E75', color:'#fff', border:'none', borderRadius:'8px', padding:'12px', fontFamily:'system-ui,sans-serif', fontSize:'14px', fontWeight:'500', cursor:'pointer', marginTop:'1rem', letterSpacing:'0.02em' },
  footer: { marginTop:'1.5rem', display:'flex', alignItems:'center', justifyContent:'space-between' },
  version: { fontSize:'11px', color:'#bbb' },
  secure: { display:'flex', alignItems:'center', fontSize:'11px', color:'#bbb' },
}