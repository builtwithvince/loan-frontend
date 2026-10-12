/**
 * Staff access code for the public application forms.
 *
 * Interim gate (2026-10-12): FinScore is billed per call and runs on every
 * submit, so the backend refuses /submit and /submit-group without the shared
 * code in `X-Apply-Passcode` (loan-backend middleware/applyPasscode.js). The
 * Apply pop-up (ApplyGate) checks the code once, keeps it for the tab, and the
 * five loan forms attach it on submit. The planned replacement is SO-assisted
 * entry behind staff login.
 *
 * sessionStorage, not localStorage: the code dies with the tab, so a shared or
 * borrowed phone doesn't keep the forms unlocked.
 */

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || 'https://loan-backend-production-cd45.up.railway.app'

const STORAGE_KEY = 'gr8_apply_passcode'
const LOCK_EVENT = 'gr8:apply-locked'

/** @returns {string} The verified code for this tab, or '' if none. */
export function getApplyPasscode() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function saveApplyPasscode(code) {
  try {
    sessionStorage.setItem(STORAGE_KEY, code)
  } catch {
    // Storage blocked (private mode quirks): the gate re-asks next page load.
  }
}

/** Headers the loan forms spread into their submit fetch. */
export function applyAccessHeaders() {
  return { 'X-Apply-Passcode': getApplyPasscode() }
}

/**
 * True when a submit was refused by the access-code gate. Matches on status
 * alone: the gate answers before the upload finishes streaming, so the body is
 * often unreadable (same failure mode as the multer gate, see submitErrors.js),
 * and nothing else on these endpoints returns 401.
 * @param {Response} res
 */
export function isAccessRefused(res) {
  return res.status === 401
}

/**
 * Forget the code and re-show the pop-up over the current form. Entries stay,
 * because the form stays mounted underneath.
 * @param {'changed'} [reason] Shown as a notice in the pop-up.
 */
export function lockApplyAccess(reason) {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing stored to clear.
  }
  window.dispatchEvent(new CustomEvent(LOCK_EVENT, { detail: { reason } }))
}

/**
 * Subscribe to re-lock events.
 * @param {(reason?: string) => void} callback
 * @returns {() => void} Unsubscribe.
 */
export function onApplyLocked(callback) {
  const handler = e => callback(e.detail?.reason)
  window.addEventListener(LOCK_EVENT, handler)
  return () => window.removeEventListener(LOCK_EVENT, handler)
}

/**
 * Check a code with the backend and keep it for the tab when it's right.
 * @param {string} code
 * @returns {Promise<{ok: true} | {ok: false, reason: 'invalid'|'rate_limited'|'unavailable'|'network'}>}
 */
export async function verifyApplyPasscode(code) {
  let res
  try {
    res = await fetch(`${API_BASE}/api/application/access`, {
      method: 'POST',
      headers: { 'X-Apply-Passcode': code },
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.ok) {
    saveApplyPasscode(code)
    return { ok: true }
  }
  if (res.status === 401) return { ok: false, reason: 'invalid' }
  if (res.status === 429) return { ok: false, reason: 'rate_limited' }
  return { ok: false, reason: 'unavailable' }
}
