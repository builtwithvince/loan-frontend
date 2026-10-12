import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { verifyApplyPasscode } from '../lib/applyAccess'

const ERROR_COPY = {
  invalid: "That code didn't work. Check it and try again.",
  rate_limited: 'Too many attempts. Please wait 15 minutes and try again.',
  unavailable: 'Applications are temporarily unavailable. Please contact us below.',
  network: "We couldn't reach our servers. Check your connection and try again.",
}

// Hold the opened lock on screen briefly so the unlock reads as a moment.
const UNLOCK_HOLD_MS = 600

/**
 * Access-code pop-up shown over the application pages until the staff code is
 * verified. Not dismissible: the page behind is inert, and the only ways out
 * are a correct code, contacting a Sales Officer, or going home.
 * @param {{ reason?: 'changed'|null, onUnlock: () => void }} props
 */
export default function ApplyAccessModal({ reason, onUnlock }) {
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | checking | unlocked
  const [error, setError] = useState(null)
  const [shaking, setShaking] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = code.trim()
    if (!trimmed || phase !== 'idle') return
    setPhase('checking')
    setError(null)
    const result = await verifyApplyPasscode(trimmed)
    if (result.ok) {
      setPhase('unlocked')
      setTimeout(onUnlock, UNLOCK_HOLD_MS)
      return
    }
    setPhase('idle')
    setError(ERROR_COPY[result.reason])
    if (result.reason === 'invalid') {
      setShaking(true)
      inputRef.current?.select()
    }
  }

  const unlocked = phase === 'unlocked'

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-canvas/70 backdrop-blur-md apply-gate-backdrop" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-gate-title"
        aria-describedby="apply-gate-desc"
        className="relative w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto bg-surface border border-border rounded-3xl card-soft apply-gate-card"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-green via-sky to-green" />

        <div className="px-6 pt-8 pb-6 sm:px-8 sm:pt-10">
          <div
            className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-colors duration-300 ${
              unlocked
                ? 'bg-green text-white'
                : 'bg-gradient-to-br from-green/12 to-sky/10 text-green'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-8 h-8 overflow-visible"
              aria-hidden="true"
            >
              <path
                d="M8.25 10.5V7.125a3.75 3.75 0 1 1 7.5 0V10.5"
                className={`apply-gate-shackle ${unlocked ? 'is-open' : ''}`}
              />
              <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.25" />
              <path d="M12 14.25v2.25" />
            </svg>
          </div>

          <p className="mt-6 text-green text-xs font-semibold uppercase tracking-[0.14em]">
            Staff access
          </p>
          <h2
            id="apply-gate-title"
            className="mt-1.5 text-white text-2xl sm:text-[1.75rem] font-bold tracking-tight leading-tight"
          >
            Enter your access code
          </h2>
          <p id="apply-gate-desc" className="mt-2 text-muted text-sm leading-relaxed">
            Loan applications are filed with a GR8 Sales Officer. Enter the access code to open the
            application form.
          </p>

          {reason === 'changed' && (
            <div className="mt-5 flex gap-3 rounded-xl border border-blue/30 bg-blue/10 px-4 py-3 text-sm text-white">
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5 shrink-0 text-blue"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z"
                  clipRule="evenodd"
                />
              </svg>
              <p>
                The access code was changed. Enter the new code, then submit again. Your entries are
                saved.
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6" noValidate>
            <label htmlFor="apply-gate-code" className="block text-sm font-medium text-white">
              Access code
            </label>
            <div
              className={`relative mt-2 ${shaking ? 'apply-gate-shake' : ''}`}
              onAnimationEnd={() => setShaking(false)}
            >
              <input
                ref={inputRef}
                id="apply-gate-code"
                type={showCode ? 'text' : 'password'}
                value={code}
                onChange={e => {
                  setCode(e.target.value)
                  if (error) setError(null)
                }}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={unlocked}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'apply-gate-error' : undefined}
                className={`w-full h-12 rounded-xl border bg-surface pl-4 pr-14 text-base text-white tracking-wide placeholder:text-muted/60 outline-none transition-[border-color,box-shadow] duration-200 focus:ring-4 ${
                  error
                    ? 'border-red-400 focus:border-red-400 focus:ring-red-400/15'
                    : 'border-border focus:border-green focus:ring-green/15'
                }`}
                placeholder="Enter access code"
              />
              <button
                type="button"
                onClick={() => setShowCode(v => !v)}
                aria-label={showCode ? 'Hide access code' : 'Show access code'}
                aria-pressed={showCode}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-11 h-11 rounded-lg flex items-center justify-center text-muted hover:text-white active:bg-surface-alt transition-colors"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-5 h-5"
                  aria-hidden="true"
                >
                  {showCode ? (
                    <path d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                  ) : (
                    <>
                      <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                      <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </>
                  )}
                </svg>
              </button>
            </div>

            <p
              id="apply-gate-error"
              role="alert"
              className={`text-sm text-red-600 transition-all ${error ? 'mt-2' : 'h-0 overflow-hidden'}`}
            >
              {error}
            </p>

            <button
              type="submit"
              disabled={!code.trim() || phase !== 'idle'}
              className="mt-5 w-full h-12 rounded-xl bg-green hover:bg-green-hover active:scale-[0.99] font-semibold text-base inline-flex items-center justify-center gap-2 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-green"
            >
              {phase === 'checking' && (
                <span
                  className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                  aria-hidden="true"
                />
              )}
              {phase === 'checking' ? 'Checking…' : unlocked ? 'Unlocked' : 'Unlock application'}
            </button>
          </form>
        </div>

        <div className="border-t border-border bg-surface-alt/60 px-6 py-5 sm:px-8">
          <p className="text-sm font-semibold text-white">Don&apos;t have a code?</p>
          <p className="mt-1 text-sm text-muted leading-relaxed">
            Our Sales Officers take applications in person. Get in touch and we&apos;ll arrange a
            visit.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <a
              href="tel:09541804946"
              className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-white hover:border-green/40 hover:text-green active:bg-surface-alt transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="w-4 h-4 text-green"
                aria-hidden="true"
              >
                <path
                  d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              (0954) 180 4946
            </a>
            <a
              href="mailto:info@gr8lendingcorporation.com"
              className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-white hover:border-green/40 hover:text-green active:bg-surface-alt transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="w-4 h-4 text-green"
                aria-hidden="true"
              >
                <path
                  d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Email us
            </a>
          </div>
          <Link
            to="/"
            className="mt-4 min-h-11 inline-flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
                clipRule="evenodd"
              />
            </svg>
            Back to home
          </Link>
        </div>
      </div>
    </div>
  )
}
