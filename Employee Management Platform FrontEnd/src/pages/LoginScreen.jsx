import { useEffect, useState } from 'react'
import { CalendarCheck2, Clock, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Wallet } from 'lucide-react'
import { BrandMark, Spinner } from '../components/ui.jsx'
import { useAuth } from '../hooks/useAuth.jsx'
import { fetchBranding } from '../api/endpoints.js'
import { DEMO_ACCOUNTS, DEMO_PASSWORD, demoAccountsEnabled } from '../data.js'

const SHOW_DEMO_ACCOUNTS = demoAccountsEnabled()

export default function LoginScreen() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [branding, setBranding] = useState(null)

  useEffect(() => {
    fetchBranding()
      .then(setBranding)
      .catch(() => setBranding(null))
  }, [])

  const fillAccount = (account) => {
    setEmail(account.email)
    setPassword(DEMO_PASSWORD)
    setError('')
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      // Credentials are verified by the API; the frontend holds no password list.
      await signIn(email.trim(), password)
    } catch (caught) {
      setError(
        caught.status === 0
          ? 'Cannot reach the server. Make sure the API is running.'
          : caught.message || 'Sign in failed. Please try again.',
      )
      setSubmitting(false)
    }
  }

  const company = branding?.companyName ?? 'POLLUX MOTORS FZE'

  return (
    <main className="login-page">
      <section className="login-story" aria-label="About Pollux HR">
        <span className="brand" style={{ color: 'white' }}>
          <BrandMark size="lg" />
          <span>
            Pollux HR
            <small>{company}</small>
          </span>
        </span>
        <div>
          <h1>
            People, time and pay for <em>Pollux Motors</em>, in one place.
          </h1>
          <p>Check in from the showroom, the road or home. Request leave and advances. Run payroll with a second pair of eyes on every number.</p>
          <div className="login-points">
            <div>
              <Clock size={18} /> Attendance in each person&apos;s own timezone and schedule
            </div>
            <div>
              <CalendarCheck2 size={18} /> Leave balances and holidays that add up
            </div>
            <div>
              <Wallet size={18} /> Monthly payroll with PDF payslips and salary advances
            </div>
          </div>
        </div>
        <p className="login-footnote">Dubai, United Arab Emirates</p>
      </section>

      <section className="login-panel">
        <div className="login-form-wrap">
          <span className="brand mobile-brand">
            <BrandMark />
            <span>Pollux HR</span>
          </span>
          <div>
            <p className="eyebrow">{company}</p>
            <h2>Sign in</h2>
            <p className="muted">Use your work email and password.</p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <label className="field">
              <span>Work email</span>
              <div className="input-with-icon">
                <Mail size={17} />
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={SHOW_DEMO_ACCOUNTS ? 'name@pollux.demo' : 'name@company.com'}
                  aria-label="Work email"
                  required
                />
              </div>
            </label>
            <label className="field">
              <span>Password</span>
              <div className="input-with-icon">
                <LockKeyhole size={17} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-label="Password"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="button button-primary button-wide" type="submit" disabled={submitting || !email || !password}>
              {submitting && <Spinner size={16} />} Sign in
            </button>
          </form>

          {SHOW_DEMO_ACCOUNTS && (
            <>
              <div className="demo-divider">Demo accounts</div>
              <div className="demo-accounts">
                {DEMO_ACCOUNTS.map((account) => (
                  <button type="button" key={account.email} onClick={() => fillAccount(account)}>
                    <strong>{account.label}</strong>
                    <small>{account.description}</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="security-note">
            <ShieldCheck size={14} /> Every access rule is enforced by the server.
          </p>
        </div>
      </section>
    </main>
  )
}
