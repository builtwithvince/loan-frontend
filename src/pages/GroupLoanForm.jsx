import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import useSalesOfficers from '../hooks/useSalesOfficers'
import {
  MAX_FILE_SIZE,
  MAX_UPLOAD_MB,
  summarizeAttachments,
  buildHttpFailureResult,
  readJsonSafely,
} from '../lib/submitErrors'
import { applyAccessHeaders, isAccessRefused, lockApplyAccess } from '../lib/applyAccess'

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || 'https://loan-backend-production-cd45.up.railway.app'

const TOTAL_STEPS = 3
// Step holding the document uploads — an upload rejection sends the
// applicant back here rather than to the review step they submitted from.
const DOCUMENTS_STEP = 2

const CIVIL_STATUSES = ['Single', 'Married', 'Widowed', 'Separated']
const EMPLOYMENT_STATUSES = [
  { value: 'Employee', label: 'Employee' },
  { value: 'Government Employee', label: 'Government Employee' },
  { value: 'Private Sector Employee', label: 'Private Sector Employee' },
  { value: 'Owner', label: 'Business Owner / Self-Employed' },
  { value: 'Overseas Worker', label: 'Overseas Worker (OFW)' },
  { value: 'Student', label: 'Student' },
  { value: 'Pensioner', label: 'Pensioner' },
  { value: 'Unemployed', label: 'Unemployed' },
]
const TERMS = [3, 6, 12]

const MEMBER_DOCS = [
  { key: 'validIdFront', label: 'Valid Government ID — Front' },
  { key: 'validIdBack', label: 'Valid Government ID — Back' },
  { key: 'barangayClearance', label: 'Barangay Clearance' },
  { key: 'payslip', label: '1 Month Payslip' },
  { key: 'coe', label: 'Certificate of Employment (COE)' },
  { key: 'proofOfBilling', label: 'Proof of Billing' },
]

const LEADER_DOCS = [...MEMBER_DOCS]

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

function createMember() {
  return {
    firstName: '',
    middleName: '',
    lastName: '',
    dateOfBirth: '',
    civilStatus: '',
    mobile: '',
    email: '',
    employmentStatus: '',
    employerName: '',
    position: '',
    monthlyIncome: '',
    loanAmount: 10000,
    houseStreet: '',
    barangay: '',
    city: '',
    province: '',
    zip: '',
  }
}

// ── Helpers ──

function getAge(dob) {
  const today = new Date()
  const birth = new Date(dob)
  let age = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
  return age
}

function validMobile(v) {
  return /^09\d{9}$/.test(v)
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

function formatPeso(n) {
  return (
    '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  )
}

// ── Shared UI ──

function Label({ children, required, htmlFor }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-white mb-1.5">
      {children}
      {required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  )
}

function Input({ value, onChange, ...props }) {
  return (
    <input
      value={value}
      onChange={onChange}
      className="w-full px-4 py-3 rounded-xl bg-surface-alt border border-border text-white text-sm placeholder:text-muted/50 focus:outline-none focus:border-green/50 focus:ring-1 focus:ring-green/30 transition-colors"
      {...props}
    />
  )
}

function Select({ value, onChange, options, placeholder, ...props }) {
  return (
    <select
      value={value}
      onChange={onChange}
      className="w-full px-4 py-3 rounded-xl bg-surface-alt border border-border text-white text-sm focus:outline-none focus:border-green/50 focus:ring-1 focus:ring-green/30 transition-colors appearance-none"
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394A3B8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10l-5 5z'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 14px center',
      }}
      {...props}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o =>
        typeof o === 'string' ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ),
      )}
    </select>
  )
}

function FieldError({ message }) {
  if (!message) return null
  return (
    <p role="alert" data-field-error className="text-red-400 text-xs mt-1">
      {message}
    </p>
  )
}

// ── Progress persistence ──
// Files can't be serialized, so a restore never goes past step 2 — every
// member's document validation always re-runs before review/submit.
const STORAGE_KEY = 'gr8-apply-group'
const RESTORE_MAX_STEP = 2
const MEMBER_KEYS = Object.keys(createMember())

function loadSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (!saved || !Array.isArray(saved.members)) return null
    saved.step = Math.min(Math.max(parseInt(saved.step, 10) || 1, 1), RESTORE_MAX_STEP)
    saved.memberCount = parseInt(saved.memberCount, 10) || 5
    return saved
  } catch {
    return null
  }
}

function restoreMember(saved) {
  if (!saved || typeof saved !== 'object') return createMember()
  const known = Object.fromEntries(Object.entries(saved).filter(([k]) => MEMBER_KEYS.includes(k)))
  return { ...createMember(), ...known }
}

// ── Component ──

export default function GroupLoanForm() {
  const [saved] = useState(loadSaved)
  const initialCount = saved && saved.memberCount >= 5 ? saved.memberCount : 5
  const [step, setStep] = useState(saved ? saved.step : 1)
  const [applicationCategory, setApplicationCategory] = useState(
    saved?.applicationCategory || 'new',
  )
  const [salesOfficerId, setSalesOfficerId] = useState(saved?.salesOfficerId || '')
  const { officers, loading: soLoading, error: soError, retry: soRetry } = useSalesOfficers()
  const [loanTerm, setLoanTerm] = useState(saved?.loanTerm || 3)
  const [memberCount, setMemberCount] = useState(initialCount)
  const [memberCountInput, setMemberCountInput] = useState(String(initialCount))
  const [members, setMembers] = useState(() =>
    Array.from({ length: initialCount }, (_, idx) => restoreMember(saved?.members?.[idx])),
  )
  const [memberDocs, setMemberDocs] = useState(() =>
    Array.from({ length: initialCount }, () => ({})),
  )
  const [expandedMembers, setExpandedMembers] = useState({ 0: true })
  const [restoredNotice, setRestoredNotice] = useState(Boolean(saved && saved.step > 1))
  const [errors, setErrors] = useState({})
  const [confirmAccurate, setConfirmAccurate] = useState(false)
  const [agreeTerms, setAgreeTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const topRef = useRef(null)
  const fileInputRefs = useRef({})

  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [step])

  // ── Persist progress so browser back / refresh doesn't wipe the application ──
  useEffect(() => {
    if (result) return
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          step,
          applicationCategory,
          salesOfficerId,
          loanTerm,
          memberCount,
          members,
        }),
      )
    } catch {
      // storage unavailable (private mode / quota) — persistence is best-effort
    }
  }, [step, applicationCategory, salesOfficerId, loanTerm, memberCount, members, result])

  useEffect(() => {
    // Terminal outcome (landed or already on file) — start the next visit clean.
    if (result && result.status !== 'error') sessionStorage.removeItem(STORAGE_KEY)
  }, [result])

  useEffect(() => {
    if (step === 1 || result) return
    const warn = e => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [step, result])

  // Sync members array with memberCount
  useEffect(() => {
    setMembers(prev => {
      if (memberCount > prev.length) {
        return [...prev, ...Array.from({ length: memberCount - prev.length }, () => createMember())]
      }
      return prev.slice(0, memberCount)
    })
    setMemberDocs(prev => {
      if (memberCount > prev.length) {
        return [...prev, ...Array.from({ length: memberCount - prev.length }, () => ({}))]
      }
      return prev.slice(0, memberCount)
    })
    // Collapse removed members
    setExpandedMembers(prev => {
      const next = { ...prev }
      Object.keys(next).forEach(k => {
        if (Number(k) >= memberCount) delete next[k]
      })
      return next
    })
  }, [memberCount])

  const updateMember = (index, key, value) => {
    setMembers(prev => prev.map((m, i) => (i === index ? { ...m, [key]: value } : m)))
    setErrors(prev => ({ ...prev, [`member_${index}_${key}`]: undefined }))
  }

  const handleFile = (memberIndex, docKey, file) => {
    if (!file) return
    const errorKey = `member_${memberIndex}_${docKey}`
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setErrors(prev => ({ ...prev, [errorKey]: 'Only JPG, PNG, or PDF files allowed' }))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setErrors(prev => ({ ...prev, [errorKey]: `File must be under ${MAX_UPLOAD_MB}MB` }))
      return
    }
    setMemberDocs(prev => prev.map((d, i) => (i === memberIndex ? { ...d, [docKey]: file } : d)))
    setErrors(prev => ({ ...prev, [errorKey]: undefined }))
  }

  const removeFile = (memberIndex, docKey) => {
    setMemberDocs(prev =>
      prev.map((d, i) => {
        if (i !== memberIndex) return d
        const next = { ...d }
        delete next[docKey]
        return next
      }),
    )
  }

  const toggleMember = index => {
    setExpandedMembers(prev => ({ ...prev, [index]: !prev[index] }))
  }

  // ── Validation ──
  const validate = () => {
    const e = {}

    if (step === 1) {
      if (!salesOfficerId) e.salesOfficerId = 'Please select your Sales Officer'
      if (memberCount < 5) e.memberCount = 'Minimum 5 members required'
    }

    if (step === 2) {
      members.forEach((m, i) => {
        const p = `member_${i}_`
        if (!m.firstName.trim()) e[`${p}firstName`] = 'Required'
        if (!m.lastName.trim()) e[`${p}lastName`] = 'Required'
        if (!m.dateOfBirth) {
          e[`${p}dateOfBirth`] = 'Required'
        } else {
          const age = getAge(m.dateOfBirth)
          if (age < 21) e[`${p}dateOfBirth`] = 'Must be at least 21 years old'
          if (age > 65) e[`${p}dateOfBirth`] = 'Must be 65 years old or younger'
        }
        if (!m.civilStatus) e[`${p}civilStatus`] = 'Required'
        if (!m.mobile.trim()) {
          e[`${p}mobile`] = 'Required'
        } else if (!validMobile(m.mobile)) {
          e[`${p}mobile`] = 'Use format 09XXXXXXXXX'
        }
        if (m.email && !validEmail(m.email)) {
          e[`${p}email`] = 'Invalid email'
        }
        if (!m.employmentStatus) e[`${p}employmentStatus`] = 'Required'
        if (!m.monthlyIncome) {
          e[`${p}monthlyIncome`] = 'Required'
        } else if (Number(m.monthlyIncome) < 5000) {
          e[`${p}monthlyIncome`] = 'Minimum income is ₱5,000/month'
        }
        if (!m.loanAmount || Number(m.loanAmount) < 10000) {
          e[`${p}loanAmount`] = 'Minimum ₱10,000'
        } else if (Number(m.loanAmount) > 50000) {
          e[`${p}loanAmount`] = 'Maximum ₱50,000'
        }
        if (!m.houseStreet.trim()) e[`${p}houseStreet`] = 'Required'
        if (!m.barangay.trim()) e[`${p}barangay`] = 'Required'
        if (!m.city.trim()) e[`${p}city`] = 'Required'
        if (!m.province.trim()) e[`${p}province`] = 'Required'
        if (!m.zip.trim()) e[`${p}zip`] = 'Required'

        // Document validation
        const requiredDocs = i === 0 ? LEADER_DOCS : MEMBER_DOCS
        requiredDocs.forEach(doc => {
          if (!memberDocs[i]?.[doc.key]) {
            e[`member_${i}_${doc.key}`] = 'This document is required'
          }
        })
      })

      // Auto-expand members with errors
      if (Object.keys(e).length > 0) {
        const membersWithErrors = new Set()
        Object.keys(e).forEach(key => {
          const match = key.match(/^member_(\d+)_/)
          if (match) membersWithErrors.add(Number(match[1]))
        })
        setExpandedMembers(prev => {
          const next = { ...prev }
          membersWithErrors.forEach(i => {
            next[i] = true
          })
          return next
        })
      }
    }

    if (step === 3) {
      if (!confirmAccurate) e.confirmAccurate = 'You must confirm before submitting'
      if (!agreeTerms) e.agreeTerms = 'You must agree to the Terms and Conditions'
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  // Errors render adjacent to fields — on long steps they can sit above the fold.
  const scrollToFirstError = () => {
    setTimeout(() => {
      document
        .querySelector('[data-field-error]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
  }

  const next = () => {
    if (validate()) setStep(s => Math.min(s + 1, TOTAL_STEPS))
    else scrollToFirstError()
  }

  const back = () => setStep(s => Math.max(s - 1, 1))

  // ── Submit ──
  const handleSubmit = async () => {
    if (!validate()) {
      scrollToFirstError()
      return
    }
    setSubmitting(true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90000)
    try {
      const leaderLast = members[0]?.lastName?.trim() || 'Group'
      const autoGroupName = `${leaderLast} Group`
      const totalAmount = members.reduce((sum, m) => sum + Number(m.loanAmount || 0), 0)

      const fd = new FormData()
      fd.append('loanType', 'group')
      // Write-only. The backend DISCARDS this value and re-derives the category
      // server-side from the mobile number (exact match against the borrower's last
      // approved application), so the selector is UX copy and nothing more. Read the
      // stored category back from the admin detail response, never from this.
      fd.append('application_category', applicationCategory)
      fd.append('sales_officer_id', salesOfficerId)
      fd.append('groupName', autoGroupName)
      fd.append('totalLoanAmount', totalAmount)
      fd.append('loanTerm', loanTerm)
      fd.append('members', JSON.stringify(members))
      fd.append('consentAgreed', 'true')

      // Append files keyed as member_${index}_file_${fileIndex}
      members.forEach((_, memberIndex) => {
        const docs = memberDocs[memberIndex] || {}
        let fileIndex = 0
        const docList = memberIndex === 0 ? LEADER_DOCS : MEMBER_DOCS
        docList.forEach(doc => {
          if (docs[doc.key]) {
            fd.append(`member_${memberIndex}_file_${fileIndex}`, docs[doc.key], docs[doc.key].name)
            fileIndex++
          }
        })
      })

      for (const [k, v] of fd.entries()) {
        console.log('[group submit]', k, v instanceof File ? `File(${v.name})` : v)
      }

      // Snapshot the attached files BEFORE fetch consumes the body, so an
      // upload rejection we cannot read can still name the likely culprit.
      const attachments = summarizeAttachments(fd)
      const res = await fetch(`${API_BASE}/api/application/submit-group`, {
        method: 'POST',
        body: fd,
        signal: controller.signal,
        headers: applyAccessHeaders(),
      })
      const data = await readJsonSafely(res)
      console.log('[group submit] response', res.status, data)
      if (res.ok && data) {
        if (data.status === 'error') {
          // 200 + status:'error' = a member's mobile number already has an
          // application under review (duplicate phone). It already landed — do
          // NOT offer a retry, or we loop on a submit that already succeeded.
          setResult({
            status: 'info',
            message:
              data.message ||
              data.error ||
              'An application for this mobile number is already under review. Please wait for our team to contact you.',
          })
        } else {
          // Backend confirmed — success or declined.
          setResult(data)
        }
      } else if (res.ok) {
        // 2xx but the body couldn't be read — the application was almost
        // certainly saved. Do NOT tell the applicant to resubmit (dup risk).
        setResult({
          status: 'uncertain',
          message:
            "Your application was likely received, but we couldn't load the confirmation. Please don't submit again — if you don't get a reference number by email, contact us before resubmitting.",
        })
      } else if (isAccessRefused(res)) {
        // The access code was changed on the backend mid-session. The gate
        // refuses before anything is saved, so re-show the pop-up over the form
        // (entries kept) rather than an error screen. No retry loop: the
        // applicant re-enters the code, then submits again.
        lockApplyAccess('changed')
      } else {
        // Any non-2xx: 4xx validation, app-level 5xx, or 502/503/504 gateway.
        // All member rows are written in ONE atomic bulk insert (no per-member
        // loop) and Loandisk borrowers are created only at admin approval, so a
        // genuine 5xx commits zero rows. Nothing was saved in any non-2xx case —
        // safe to retry.
        // The multer upload gate answers mid-stream, so its 400 body is often
        // truncated and unreadable — buildHttpFailureResult reconstructs a
        // specific, actionable message from the status plus `attachments`.
        setResult(buildHttpFailureResult({ status: res.status, data, attachments }))
      }
    } catch (err) {
      console.error('[group submit] failed', err)
      if (err.name === 'AbortError') {
        // Timed out waiting for a response — it may still have gone through.
        setResult({
          status: 'uncertain',
          message:
            "Your application is taking longer than expected to confirm. It may still have gone through — please don't submit again. If you don't receive a reference number, contact us first.",
        })
      } else {
        setResult({
          status: 'error',
          message:
            "We couldn't reach our servers, so your application wasn't submitted. Please check your connection and try again.",
        })
      }
    } finally {
      clearTimeout(timer)
      setSubmitting(false)
    }
  }

  // ── Result screens ──
  if (result) {
    if (result.status === 'success') {
      return (
        <div className="min-h-screen flex items-center justify-center px-6 pt-24 pb-16">
          <div className="max-w-lg w-full text-center">
            <div className="w-20 h-20 rounded-full bg-green/10 border border-green/30 flex items-center justify-center mx-auto mb-6 result-badge">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="w-10 h-10 text-green"
              >
                <path
                  d="M4.5 12.75l6 6 9-13.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="result-draw-check"
                />
              </svg>
            </div>
            <h2 className="text-3xl font-bold text-green mb-4">Application Received</h2>
            <p className="text-white text-lg mb-2">
              Reference ID: <span className="text-green font-bold">{result.referenceId}</span>
            </p>
            <p className="text-muted mb-2">
              Total members processed:{' '}
              <span className="text-white font-semibold">{memberCount}</span>
            </p>
            <p className="text-muted mb-8">
              Your group loan application has been received. Our team will review it within 2–3
              business days.
            </p>
            <Link
              to="/"
              className="inline-block px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold rounded-xl transition-all"
            >
              Back to Home
            </Link>
          </div>
        </div>
      )
    }

    if (result.status === 'declined') {
      return (
        <div className="min-h-screen flex items-center justify-center px-6 pt-24 pb-16">
          <div className="max-w-lg w-full text-center">
            <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-6 result-badge">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="w-10 h-10 text-red-400"
              >
                <path
                  d="M6 18L18 6M6 6l12 12"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="result-draw-x"
                />
              </svg>
            </div>
            <h2 className="text-3xl font-bold text-red-400 mb-4">Application Declined</h2>
            <ul className="text-left bg-surface border border-border rounded-xl p-6 mb-8 space-y-2">
              {(result.reasons || []).map((r, i) => (
                <li key={i} className="text-muted text-sm flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span> {r}
                </li>
              ))}
            </ul>
            <Link
              to="/"
              className="inline-block px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold rounded-xl transition-all"
            >
              Back to Home
            </Link>
          </div>
        </div>
      )
    }

    // Error — show which member failed if available
    return (
      <div className="min-h-screen flex items-center justify-center px-6 pt-24 pb-16">
        <div className="max-w-lg w-full text-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${
              result.status === 'info'
                ? 'bg-blue/10 border border-blue/30 result-badge'
                : 'bg-yellow-500/10 border border-yellow-500/30 result-badge-warn'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`w-10 h-10 ${result.status === 'info' ? 'text-blue' : 'text-yellow-400'}`}
            >
              <path
                d={
                  result.status === 'info'
                    ? 'M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z'
                    : 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z'
                }
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2
            className={`text-3xl font-bold mb-4 ${result.status === 'info' ? 'text-blue' : 'text-yellow-400'}`}
          >
            {result.title ||
              (result.status === 'uncertain'
                ? 'Submission Pending Confirmation'
                : result.status === 'info'
                  ? 'Already Under Review'
                  : 'Something Went Wrong')}
          </h2>
          <p className={`text-muted ${result.suggestions?.length ? 'mb-5' : 'mb-8'}`}>
            {result.message || 'An unexpected error occurred.'}
          </p>
          {result.suggestions?.length > 0 && (
            <div className="text-left bg-surface border border-border rounded-xl p-5 mb-8">
              <p className="text-white text-sm font-semibold mb-3">What you can do:</p>
              <ul className="space-y-2">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="text-muted text-sm flex items-start gap-2">
                    <span className="text-green mt-0.5 shrink-0">&bull;</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.status === 'uncertain' ? (
            <Link
              to="/"
              className="inline-block px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold rounded-xl transition-all"
            >
              Back to Home
            </Link>
          ) : result.status === 'info' ? (
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={() => setResult(null)}
                className="inline-block px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold rounded-xl transition-all"
              >
                Try another application
              </button>
              <Link
                to="/"
                className="inline-block px-4 py-2 text-muted hover:text-white text-sm font-medium transition-colors"
              >
                Back to Home
              </Link>
            </div>
          ) : (
            <button
              onClick={() => {
                if (result.refocusDocuments) setStep(DOCUMENTS_STEP)
                setResult(null)
              }}
              className="inline-block px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold rounded-xl transition-all"
            >
              {result.actionLabel || 'Try Again'}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Progress ──
  const progress = (step / TOTAL_STEPS) * 100
  const stepLabels = ['Group Details', 'Members', 'Review & Submit']
  const totalLoanAmount = members.reduce((sum, m) => sum + Number(m.loanAmount || 0), 0)
  const autoGroupName = (members[0]?.lastName?.trim() || 'Group') + ' Group'

  return (
    <div ref={topRef} className="min-h-screen pt-28 pb-16 px-4 sm:px-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link
            to="/"
            className="text-muted hover:text-white text-sm transition-colors inline-flex items-center gap-1 mb-4"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path
                fillRule="evenodd"
                d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
                clipRule="evenodd"
              />
            </svg>
            Back to Home
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-green">Group Loan Application</h1>
          <p className="text-muted text-sm mt-1">
            Step {step} of {TOTAL_STEPS} — {stepLabels[step - 1]}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-surface-alt rounded-full mb-10 overflow-hidden">
          <div
            className="h-full bg-green rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Form card */}
        <div className="bg-surface/60 backdrop-blur-sm border border-border rounded-2xl p-6 sm:p-8">
          {restoredNotice && (
            <div className="flex items-start justify-between gap-3 bg-blue/10 border border-blue/30 rounded-xl px-4 py-3 mb-6">
              <p className="text-blue text-sm">
                We restored your saved progress. Uploaded documents can't be kept between visits —
                please re-attach each member's documents.
              </p>
              <button
                type="button"
                onClick={() => setRestoredNotice(false)}
                className="text-blue hover:text-white text-xs font-semibold shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          {/* ══ STEP 1: Group Details ══ */}
          {step === 1 && (
            <div className="space-y-6">
              <h2 className="text-xl font-bold text-green mb-1">Group Details</h2>
              <p className="text-muted text-sm mb-4">Set up your group loan parameters.</p>

              {/* Application Type */}
              <div>
                <label className="block text-sm font-medium text-white mb-2">
                  Application Type
                </label>
                <div className="flex rounded-xl border border-border overflow-hidden">
                  {[
                    ['new', 'New Loan'],
                    ['renewal', 'Renewal'],
                  ].map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setApplicationCategory(val)}
                      className={`flex-1 py-3 text-sm font-medium transition-colors ${
                        applicationCategory === val
                          ? 'bg-green text-white'
                          : 'bg-surface-alt text-muted hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Renewal note — the selector is UX only. Matching this application to
                  an existing client record is done server-side, so the applicant is
                  never asked to hunt down their own borrower record. */}
              {applicationCategory === 'renewal' && (
                <p className="text-muted text-xs bg-surface-alt border border-border rounded-xl px-4 py-3">
                  We'll match each member to their existing GR8 record automatically using their
                  mobile number. Just fill in the form as usual.
                </p>
              )}

              {/* Sales Officer Selection */}
              <div className="mb-6">
                <label htmlFor="salesOfficerId" className="block text-sm text-muted mb-2">
                  Your Sales Officer <span className="text-red-400">*</span>
                </label>
                {soError ? (
                  <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-red-400 text-sm flex-1">
                      Unable to load officers, please refresh
                    </p>
                    <button
                      type="button"
                      onClick={soRetry}
                      className="text-green text-sm hover:text-green-hover transition-colors whitespace-nowrap"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <select
                    id="salesOfficerId"
                    value={salesOfficerId}
                    onChange={e => {
                      setSalesOfficerId(e.target.value)
                      setErrors(prev => ({ ...prev, salesOfficerId: undefined }))
                    }}
                    disabled={soLoading}
                    className="w-full bg-surface-alt border border-border rounded-lg px-4 py-3 text-white focus:border-green/50 focus:ring-1 focus:ring-green/30 outline-none disabled:opacity-50 appearance-none"
                  >
                    <option value="">
                      {soLoading ? 'Loading sales officers…' : 'Select your Sales Officer'}
                    </option>
                    {officers.map(o => (
                      <option key={o.id} value={o.id}>
                        {o.full_name}
                      </option>
                    ))}
                  </select>
                )}
                {errors.salesOfficerId && (
                  <p role="alert" data-field-error className="text-red-400 text-xs mt-1">
                    {errors.salesOfficerId}
                  </p>
                )}
              </div>

              <div className="bg-surface-alt/30 border border-border rounded-xl p-4">
                <p className="text-muted text-xs">
                  Group name will be auto-generated from Member 1's last name (e.g. "Dela Cruz
                  Group"). Each member sets their own desired loan amount.
                </p>
              </div>

              {/* Term */}
              <div>
                <Label required>Loan Term</Label>
                <div className="flex gap-3 mt-1">
                  {TERMS.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setLoanTerm(t)}
                      className={`flex-1 py-3 rounded-xl text-sm font-medium border transition-all ${
                        loanTerm === t
                          ? 'border-green bg-green/10 text-green'
                          : 'border-border text-muted hover:border-muted/30 hover:text-white'
                      }`}
                    >
                      {t} months
                    </button>
                  ))}
                </div>
              </div>

              {/* Repayment */}
              <div>
                <Label>Repayment Schedule</Label>
                <div className="px-4 py-3 rounded-xl bg-surface-alt/50 border border-border text-muted text-sm">
                  Bimonthly
                </div>
              </div>

              {/* Number of members */}
              <div>
                <Label required htmlFor="memberCount">
                  Number of Members
                </Label>
                <Input
                  id="memberCount"
                  type="number"
                  value={memberCountInput}
                  onChange={e => {
                    setMemberCountInput(e.target.value)
                    setErrors(prev => ({ ...prev, memberCount: undefined }))
                  }}
                  onBlur={() => {
                    const v = Math.max(5, parseInt(memberCountInput, 10) || 5)
                    setMemberCount(v)
                    setMemberCountInput(String(v))
                  }}
                  min={5}
                  placeholder="Minimum 5"
                />
                <FieldError message={errors.memberCount} />
              </div>
            </div>
          )}

          {/* ══ STEP 2: Members ══ */}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-green mb-1">Member Information</h2>
              <p className="text-muted text-sm mb-4">
                Fill in details for all {memberCount} members. Member 1 is the group leader.
              </p>

              {members.map((member, i) => {
                const isLeader = i === 0
                const isExpanded = expandedMembers[i]
                const prefix = `member_${i}_`
                const docs = memberDocs[i] || {}
                const requiredDocList = isLeader ? LEADER_DOCS : MEMBER_DOCS
                const hasErrors = Object.keys(errors).some(k => k.startsWith(prefix) && errors[k])
                const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ')

                return (
                  <div
                    key={i}
                    className={`border rounded-2xl overflow-hidden transition-all ${hasErrors ? 'border-red-400/50' : 'border-border'}`}
                  >
                    {/* Collapsible header */}
                    <button
                      type="button"
                      onClick={() => toggleMember(i)}
                      className="w-full flex items-center justify-between p-4 sm:p-5 bg-surface-alt/30 hover:bg-surface-alt/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${isLeader ? 'bg-green/20 text-green' : 'bg-blue/20 text-blue'}`}
                        >
                          {i + 1}
                        </div>
                        <div>
                          <span className="text-white text-sm font-semibold">
                            Member {i + 1}
                            {isLeader ? ' (Leader)' : ''}
                          </span>
                          {memberName && (
                            <span className="text-muted text-xs block">{memberName}</span>
                          )}
                        </div>
                        {hasErrors && <span className="text-red-400 text-xs">Has errors</span>}
                      </div>
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`w-5 h-5 text-muted transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      >
                        <path
                          fillRule="evenodd"
                          d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="p-4 sm:p-6 space-y-6 border-t border-border">
                        {/* Personal Information */}
                        <div className="space-y-4">
                          <h3 className="text-blue text-xs font-semibold uppercase tracking-wider">
                            Personal Information
                          </h3>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_firstName`}>
                                First Name
                              </Label>
                              <Input
                                id={`member_${i}_firstName`}
                                value={member.firstName}
                                onChange={e => updateMember(i, 'firstName', e.target.value)}
                                placeholder="Juan"
                              />
                              <FieldError message={errors[`${prefix}firstName`]} />
                            </div>
                            <div>
                              <Label htmlFor={`member_${i}_middleName`}>Middle Name</Label>
                              <Input
                                id={`member_${i}_middleName`}
                                value={member.middleName}
                                onChange={e => updateMember(i, 'middleName', e.target.value)}
                                placeholder="Santos"
                              />
                            </div>
                            <div>
                              <Label required htmlFor={`member_${i}_lastName`}>
                                Last Name
                              </Label>
                              <Input
                                id={`member_${i}_lastName`}
                                value={member.lastName}
                                onChange={e => updateMember(i, 'lastName', e.target.value)}
                                placeholder="Dela Cruz"
                              />
                              <FieldError message={errors[`${prefix}lastName`]} />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_dateOfBirth`}>
                                Date of Birth
                              </Label>
                              <Input
                                id={`member_${i}_dateOfBirth`}
                                type="date"
                                value={member.dateOfBirth}
                                onChange={e => updateMember(i, 'dateOfBirth', e.target.value)}
                              />
                              <FieldError message={errors[`${prefix}dateOfBirth`]} />
                            </div>
                            <div>
                              <Label required htmlFor={`member_${i}_civilStatus`}>
                                Civil Status
                              </Label>
                              <Select
                                id={`member_${i}_civilStatus`}
                                value={member.civilStatus}
                                onChange={e => updateMember(i, 'civilStatus', e.target.value)}
                                options={CIVIL_STATUSES}
                                placeholder="Select status"
                              />
                              <FieldError message={errors[`${prefix}civilStatus`]} />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_mobile`}>
                                Mobile Number
                              </Label>
                              <Input
                                id={`member_${i}_mobile`}
                                type="tel"
                                inputMode="numeric"
                                value={member.mobile}
                                onChange={e => updateMember(i, 'mobile', e.target.value)}
                                placeholder="09XXXXXXXXX"
                                maxLength={11}
                              />
                              <FieldError message={errors[`${prefix}mobile`]} />
                            </div>
                            <div>
                              <Label htmlFor={`member_${i}_email`}>Email Address</Label>
                              <Input
                                id={`member_${i}_email`}
                                type="email"
                                value={member.email}
                                onChange={e => updateMember(i, 'email', e.target.value)}
                                placeholder="juan@email.com"
                              />
                              <FieldError message={errors[`${prefix}email`]} />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_employmentStatus`}>
                                Employment Status
                              </Label>
                              <Select
                                id={`member_${i}_employmentStatus`}
                                value={member.employmentStatus}
                                onChange={e => updateMember(i, 'employmentStatus', e.target.value)}
                                options={EMPLOYMENT_STATUSES}
                                placeholder="Select status"
                              />
                              <FieldError message={errors[`${prefix}employmentStatus`]} />
                            </div>
                            <div>
                              <Label required htmlFor={`member_${i}_monthlyIncome`}>
                                Monthly Income (₱)
                              </Label>
                              <Input
                                id={`member_${i}_monthlyIncome`}
                                inputMode="numeric"
                                type="number"
                                value={member.monthlyIncome}
                                onChange={e => updateMember(i, 'monthlyIncome', e.target.value)}
                                placeholder="5000"
                                min={0}
                              />
                              <FieldError message={errors[`${prefix}monthlyIncome`]} />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label htmlFor={`member_${i}_employerName`}>Employer Name</Label>
                              <Input
                                id={`member_${i}_employerName`}
                                value={member.employerName}
                                onChange={e => updateMember(i, 'employerName', e.target.value)}
                                placeholder="Company / Employer"
                              />
                            </div>
                            <div>
                              <Label htmlFor={`member_${i}_position`}>Position</Label>
                              <Input
                                id={`member_${i}_position`}
                                value={member.position}
                                onChange={e => updateMember(i, 'position', e.target.value)}
                                placeholder="Job title"
                              />
                            </div>
                          </div>

                          {/* Individual loan amount */}
                          <div>
                            <Label required htmlFor={`member_${i}_loanAmount`}>
                              Desired Loan Amount (₱)
                            </Label>
                            <p className="text-muted text-xs mb-2">₱10,000 – ₱50,000</p>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-green font-bold text-lg">
                                ₱
                              </span>
                              <input
                                id={`member_${i}_loanAmount`}
                                type="text"
                                inputMode="numeric"
                                value={Number(member.loanAmount).toLocaleString('en-PH')}
                                onChange={e => {
                                  const raw = e.target.value.replace(/[^0-9]/g, '')
                                  const num = parseInt(raw, 10)
                                  if (raw === '') {
                                    updateMember(i, 'loanAmount', 0)
                                    return
                                  }
                                  if (!isNaN(num)) updateMember(i, 'loanAmount', num)
                                }}
                                onBlur={() => {
                                  updateMember(
                                    i,
                                    'loanAmount',
                                    Math.min(Math.max(Number(member.loanAmount), 10000), 50000),
                                  )
                                }}
                                className="w-full pl-8 pr-3 py-3 rounded-xl bg-surface-alt border border-border text-green text-right text-xl font-bold focus:outline-none focus:border-green/50 focus:ring-1 focus:ring-green/30 transition-colors"
                              />
                            </div>
                            <FieldError message={errors[`${prefix}loanAmount`]} />
                          </div>
                        </div>

                        {/* Address */}
                        <div className="space-y-4">
                          <h3 className="text-blue text-xs font-semibold uppercase tracking-wider">
                            Address
                          </h3>

                          <div>
                            <Label required htmlFor={`member_${i}_houseStreet`}>
                              House No. / Street
                            </Label>
                            <Input
                              id={`member_${i}_houseStreet`}
                              value={member.houseStreet}
                              onChange={e => updateMember(i, 'houseStreet', e.target.value)}
                              placeholder="123 Rizal St."
                            />
                            <FieldError message={errors[`${prefix}houseStreet`]} />
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_barangay`}>
                                Barangay
                              </Label>
                              <Input
                                id={`member_${i}_barangay`}
                                value={member.barangay}
                                onChange={e => updateMember(i, 'barangay', e.target.value)}
                                placeholder="Brgy. San Pablo"
                              />
                              <FieldError message={errors[`${prefix}barangay`]} />
                            </div>
                            <div>
                              <Label required htmlFor={`member_${i}_city`}>
                                City / Municipality
                              </Label>
                              <Input
                                id={`member_${i}_city`}
                                value={member.city}
                                onChange={e => updateMember(i, 'city', e.target.value)}
                                placeholder="Malolos"
                              />
                              <FieldError message={errors[`${prefix}city`]} />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <Label required htmlFor={`member_${i}_province`}>
                                Province
                              </Label>
                              <Input
                                id={`member_${i}_province`}
                                value={member.province}
                                onChange={e => updateMember(i, 'province', e.target.value)}
                                placeholder="Bulacan"
                              />
                              <FieldError message={errors[`${prefix}province`]} />
                            </div>
                            <div>
                              <Label required htmlFor={`member_${i}_zip`}>
                                ZIP Code
                              </Label>
                              <Input
                                id={`member_${i}_zip`}
                                inputMode="numeric"
                                value={member.zip}
                                onChange={e => updateMember(i, 'zip', e.target.value)}
                                placeholder="3000"
                                maxLength={4}
                              />
                              <FieldError message={errors[`${prefix}zip`]} />
                            </div>
                          </div>
                        </div>

                        {/* Document Upload */}
                        <div className="space-y-3">
                          <h3 className="text-blue text-xs font-semibold uppercase tracking-wider">
                            Document Upload
                          </h3>
                          <p className="text-muted text-xs">
                            JPG, PNG, or PDF only. Max {MAX_UPLOAD_MB}MB per file.
                          </p>

                          {requiredDocList.map(doc => {
                            const file = docs[doc.key]
                            const errorKey = `member_${i}_${doc.key}`
                            const refKey = `${i}_${doc.key}`
                            return (
                              <div
                                key={doc.key}
                                className="bg-surface-alt/20 border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="text-white text-sm font-medium">
                                    {doc.label}
                                    <span className="text-red-400 ml-1">*</span>
                                  </div>
                                  {file ? (
                                    <div className="flex items-center gap-2 mt-1">
                                      <svg
                                        viewBox="0 0 20 20"
                                        fill="currentColor"
                                        className="w-4 h-4 text-green shrink-0"
                                      >
                                        <path
                                          fillRule="evenodd"
                                          d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                                          clipRule="evenodd"
                                        />
                                      </svg>
                                      <span className="text-muted text-xs truncate">
                                        {file.name}
                                      </span>
                                      <button
                                        onClick={() => removeFile(i, doc.key)}
                                        className="text-red-400 hover:text-red-300 text-xs shrink-0 ml-1"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ) : (
                                    <FieldError message={errors[errorKey]} />
                                  )}
                                </div>
                                <div className="shrink-0">
                                  <input
                                    ref={el => (fileInputRefs.current[refKey] = el)}
                                    type="file"
                                    accept=".jpg,.jpeg,.png,.pdf"
                                    onChange={e => {
                                      handleFile(i, doc.key, e.target.files[0])
                                      e.target.value = ''
                                    }}
                                    className="hidden"
                                  />
                                  <button
                                    onClick={() => fileInputRefs.current[refKey]?.click()}
                                    className="px-4 py-2 border border-blue/30 text-blue text-xs font-medium rounded-lg hover:bg-blue/10 transition-all"
                                  >
                                    {file ? 'Replace' : 'Choose File'}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ══ STEP 3: Review & Submit ══ */}
          {step === 3 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-green mb-1">Review Your Application</h2>
              <p className="text-muted text-sm mb-4">
                Please review all information before submitting.
              </p>

              {/* Group summary */}
              <div className="bg-surface-alt/20 border border-border rounded-xl p-5">
                <h3 className="text-blue text-xs font-semibold uppercase tracking-wider mb-3">
                  Group Details
                </h3>
                <div className="space-y-2">
                  <div className="flex justify-between gap-4 text-sm">
                    <span className="text-muted shrink-0">Group Name</span>
                    <span className="text-white text-right">{autoGroupName}</span>
                  </div>
                  <div className="flex justify-between gap-4 text-sm">
                    <span className="text-muted shrink-0">Total Loan Amount</span>
                    <span className="text-white text-right">{formatPeso(totalLoanAmount)}</span>
                  </div>
                  <div className="flex justify-between gap-4 text-sm">
                    <span className="text-muted shrink-0">Loan Term</span>
                    <span className="text-white text-right">{loanTerm} months</span>
                  </div>
                  <div className="flex justify-between gap-4 text-sm">
                    <span className="text-muted shrink-0">Repayment</span>
                    <span className="text-white text-right">Bimonthly</span>
                  </div>
                  <div className="flex justify-between gap-4 text-sm">
                    <span className="text-muted shrink-0">Members</span>
                    <span className="text-white text-right">{memberCount}</span>
                  </div>
                </div>
              </div>

              {/* Members summary */}
              {members.map((m, i) => {
                const memberName = [m.firstName, m.middleName, m.lastName].filter(Boolean).join(' ')
                const docCount = Object.keys(memberDocs[i] || {}).length
                return (
                  <div key={i} className="bg-surface-alt/20 border border-border rounded-xl p-5">
                    <h3 className="text-blue text-xs font-semibold uppercase tracking-wider mb-3">
                      Member {i + 1}
                      {i === 0 ? ' (Leader)' : ''}
                    </h3>
                    <div className="space-y-2">
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Name</span>
                        <span className="text-white text-right">{memberName}</span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Loan Amount</span>
                        <span className="text-green text-right font-semibold">
                          {formatPeso(m.loanAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Mobile</span>
                        <span className="text-white text-right">{m.mobile}</span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Employment</span>
                        <span className="text-white text-right">{m.employmentStatus}</span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Monthly Income</span>
                        <span className="text-white text-right">{formatPeso(m.monthlyIncome)}</span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Address</span>
                        <span className="text-white text-right break-all">
                          {m.houseStreet}, {m.barangay}, {m.city}, {m.province} {m.zip}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4 text-sm">
                        <span className="text-muted shrink-0">Documents</span>
                        <span className="text-white text-right">{docCount} uploaded</span>
                      </div>
                    </div>
                  </div>
                )
              })}

              <label className="flex items-start gap-3 cursor-pointer group pt-2">
                <input
                  type="checkbox"
                  checked={confirmAccurate}
                  onChange={e => {
                    setConfirmAccurate(e.target.checked)
                    setErrors(prev => ({ ...prev, confirmAccurate: undefined }))
                  }}
                  className="w-5 h-5 rounded border-border bg-surface-alt text-green focus:ring-green/30 accent-green mt-0.5"
                />
                <span className="text-white text-sm leading-relaxed group-hover:text-green transition-colors">
                  I confirm that all information provided is true and accurate to the best of my
                  knowledge.
                </span>
              </label>
              <FieldError message={errors.confirmAccurate} />

              <label className="flex items-start gap-3 cursor-pointer group pt-2">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={e => {
                    setAgreeTerms(e.target.checked)
                    setErrors(prev => ({ ...prev, agreeTerms: undefined }))
                  }}
                  className="w-5 h-5 rounded border-border bg-surface-alt text-green focus:ring-green/30 accent-green mt-0.5"
                />
                <span className="text-white text-sm leading-relaxed group-hover:text-green transition-colors">
                  I have read and agree to the{' '}
                  <a
                    href="/termsandconditions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green underline hover:text-green-hover"
                  >
                    Terms and Conditions
                  </a>{' '}
                  and Data Privacy Policy of GR8 Lending Corporation.
                </span>
              </label>
              <FieldError message={errors.agreeTerms} />
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between items-center mt-8 pt-6 border-t border-border">
            {step > 1 ? (
              <button
                onClick={back}
                className="px-6 py-3 border border-border text-muted hover:text-white hover:border-muted/50 font-medium text-sm rounded-xl transition-all"
              >
                Back
              </button>
            ) : (
              <div />
            )}

            {step < TOTAL_STEPS ? (
              <button
                onClick={next}
                className="px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold text-sm rounded-xl transition-all hover:shadow-lg hover:shadow-green/20"
              >
                Continue
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-8 py-3 bg-green hover:bg-green-hover text-white font-semibold text-sm rounded-xl transition-all hover:shadow-lg hover:shadow-green/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting…' : 'Submit Application'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
