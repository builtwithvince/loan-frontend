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

const TOTAL_STEPS = 8
// Step holding the document uploads — an upload rejection sends the
// applicant back here rather than to the review step they submitted from.
const DOCUMENTS_STEP = 7

const PURPOSES = [
  'Medical',
  'Education',
  'Home Improvement',
  'Business Capital',
  'Emergency',
  'Other',
]
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

const REQUIRED_DOCS = [
  { key: 'barangayClearance', label: 'Barangay Clearance' },
  { key: 'validIdFront', label: 'Valid Government ID — Front' },
  { key: 'validIdBack', label: 'Valid Government ID — Back' },
  { key: 'payslip', label: '3 Months Payslip' },
  { key: 'coe', label: 'Certificate of Employment' },
  { key: 'proofOfBilling', label: 'Proof of Billing' },
]

const OPTIONAL_DOCS = [
  { key: 'prcId', label: 'PRC ID (if applicable)' },
  { key: 'companyId', label: 'Company ID' },
]

const ALL_DOCS = [...REQUIRED_DOCS, ...OPTIONAL_DOCS]

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

const initialForm = {
  // Step 1
  application_category: 'new',
  salesOfficerId: '',
  loanAmount: 10000,
  paymentTerm: 3,
  purpose: '',
  // Step 2
  firstName: '',
  middleName: '',
  lastName: '',
  dateOfBirth: '',
  civilStatus: '',
  mobile: '',
  email: '',
  tin: '',
  // Step 3
  presentHouseStreet: '',
  presentBarangay: '',
  presentCity: '',
  presentProvince: '',
  presentZip: '',
  presentLengthOfStay: '',
  // Step 4
  sameAsPresent: false,
  permanentHouseStreet: '',
  permanentBarangay: '',
  permanentCity: '',
  permanentProvince: '',
  permanentZip: '',
  permanentLengthOfStay: '',
  // Step 5
  employmentStatus: '',
  employerName: '',
  monthlyIncome: '',
  lengthOfEmployment: '',
  // Step 6
  addSpouse: false,
  spouseFirstName: '',
  spouseLastName: '',
  spouseMobile: '',
  spouseEmployer: '',
  spouseIncome: '',
  // Step 8
  confirmAccurate: false,
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
// Files can't be serialized, so a restore never goes past the document-upload
// step — document validation always re-runs before review/submit.
const STORAGE_KEY = 'gr8-apply-personal'
const RESTORE_MAX_STEP = 7

function loadSaved() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (!saved || typeof saved.form !== 'object' || saved.form === null) return null
    saved.step = Math.min(Math.max(parseInt(saved.step, 10) || 1, 1), RESTORE_MAX_STEP)
    return saved
  } catch {
    return null
  }
}

// ── Component ──

export default function PersonalLoanForm() {
  const [saved] = useState(loadSaved)
  const [step, setStep] = useState(saved ? saved.step : 1)
  const [form, setForm] = useState(() => {
    if (!saved) return initialForm
    const known = Object.fromEntries(Object.entries(saved.form).filter(([k]) => k in initialForm))
    return { ...initialForm, ...known }
  })
  const [restoredNotice, setRestoredNotice] = useState(Boolean(saved && saved.step > 1))
  const { officers, loading: soLoading, error: soError, retry: soRetry } = useSalesOfficers()
  const [docs, setDocs] = useState({})
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null) // { status, referenceId?, reasons?, message? }
  const topRef = useRef(null)

  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [step])

  // ── Persist progress so browser back / refresh doesn't wipe the application ──
  useEffect(() => {
    if (result) return
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, form }))
    } catch {
      // storage unavailable (private mode / quota) — persistence is best-effort
    }
  }, [step, form, result])

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

  const set = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
  }

  // ── Same as present address ──
  useEffect(() => {
    if (form.sameAsPresent) {
      setForm(prev => ({
        ...prev,
        permanentHouseStreet: prev.presentHouseStreet,
        permanentBarangay: prev.presentBarangay,
        permanentCity: prev.presentCity,
        permanentProvince: prev.presentProvince,
        permanentZip: prev.presentZip,
        permanentLengthOfStay: prev.presentLengthOfStay,
      }))
    }
  }, [
    form.sameAsPresent,
    form.presentHouseStreet,
    form.presentBarangay,
    form.presentCity,
    form.presentProvince,
    form.presentZip,
    form.presentLengthOfStay,
  ])

  // ── File handling ──
  const handleFile = (key, file) => {
    if (!file) return
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setErrors(prev => ({ ...prev, [key]: 'Only JPG, PNG, or PDF files allowed' }))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setErrors(prev => ({ ...prev, [key]: `File must be under ${MAX_UPLOAD_MB}MB` }))
      return
    }
    setDocs(prev => ({ ...prev, [key]: file }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
  }

  const removeFile = key => {
    setDocs(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // ── Validation per step ──
  const validate = () => {
    const e = {}

    if (step === 1) {
      if (!form.salesOfficerId) e.salesOfficerId = 'Please select your Sales Officer'
      if (!form.purpose) e.purpose = 'Purpose is required'
    }

    if (step === 2) {
      if (!form.firstName.trim()) e.firstName = 'Required'
      if (!form.lastName.trim()) e.lastName = 'Required'
      if (!form.dateOfBirth) {
        e.dateOfBirth = 'Required'
      } else {
        const age = getAge(form.dateOfBirth)
        if (age < 21) e.dateOfBirth = 'Must be at least 21 years old'
        if (age > 65) e.dateOfBirth = 'Must be 65 years old or younger'
      }
      if (!form.civilStatus) e.civilStatus = 'Required'
      if (!form.mobile.trim()) {
        e.mobile = 'Required'
      } else if (!validMobile(form.mobile)) {
        e.mobile = 'Use format 09XXXXXXXXX'
      }
      if (!form.email.trim()) {
        e.email = 'Required'
      } else if (!validEmail(form.email)) {
        e.email = 'Invalid email'
      }
    }

    if (step === 3) {
      if (!form.presentHouseStreet.trim()) e.presentHouseStreet = 'Required'
      if (!form.presentBarangay.trim()) e.presentBarangay = 'Required'
      if (!form.presentCity.trim()) e.presentCity = 'Required'
      if (!form.presentProvince.trim()) e.presentProvince = 'Required'
      if (!form.presentZip.trim()) e.presentZip = 'Required'
      if (!form.presentLengthOfStay.trim()) e.presentLengthOfStay = 'Required'
    }

    if (step === 4 && !form.sameAsPresent) {
      if (!form.permanentHouseStreet.trim()) e.permanentHouseStreet = 'Required'
      if (!form.permanentBarangay.trim()) e.permanentBarangay = 'Required'
      if (!form.permanentCity.trim()) e.permanentCity = 'Required'
      if (!form.permanentProvince.trim()) e.permanentProvince = 'Required'
      if (!form.permanentZip.trim()) e.permanentZip = 'Required'
      if (!form.permanentLengthOfStay.trim()) e.permanentLengthOfStay = 'Required'
    }

    if (step === 5) {
      if (!form.employmentStatus) e.employmentStatus = 'Required'
      if (!form.employerName.trim()) e.employerName = 'Required'
      if (!form.monthlyIncome) {
        e.monthlyIncome = 'Required'
      } else if (Number(form.monthlyIncome) < 15000) {
        e.monthlyIncome = 'Minimum income is ₱15,000/month'
      }
      if (!form.lengthOfEmployment.trim()) e.lengthOfEmployment = 'Required'
    }

    if (step === 6 && form.addSpouse) {
      if (!form.spouseFirstName.trim()) e.spouseFirstName = 'Required'
      if (!form.spouseLastName.trim()) e.spouseLastName = 'Required'
      if (!form.spouseMobile.trim()) {
        e.spouseMobile = 'Required'
      } else if (!validMobile(form.spouseMobile)) {
        e.spouseMobile = 'Use format 09XXXXXXXXX'
      }
    }

    if (step === 7) {
      REQUIRED_DOCS.forEach(d => {
        if (!docs[d.key]) e[d.key] = 'This document is required'
      })
    }

    if (step === 8) {
      if (!form.confirmAccurate) e.confirmAccurate = 'You must confirm before submitting'
      if (!form.agreeTerms) e.agreeTerms = 'You must agree to the Terms and Conditions'
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
      const fd = new FormData()
      fd.append('loanType', 'personal')
      // Write-only. The backend DISCARDS this value and re-derives the category
      // server-side from the mobile number (exact match against the borrower's last
      // approved application), so the selector is UX copy and nothing more. Read the
      // stored category back from the admin detail response, never from this.
      fd.append('application_category', form.application_category)
      const keyMap = { presentBarangay: 'barangay', salesOfficerId: 'sales_officer_id' }
      Object.entries(form).forEach(([k, v]) => {
        if (
          k !== 'confirmAccurate' &&
          k !== 'agreeTerms' &&
          k !== 'sameAsPresent' &&
          k !== 'addSpouse' &&
          k !== 'application_category'
        ) {
          fd.append(keyMap[k] || k, v)
        }
      })
      Object.entries(docs).forEach(([k, file]) => {
        fd.append(k, file, file.name)
      })
      // Snapshot the attached files BEFORE fetch consumes the body, so an
      // upload rejection we cannot read can still name the likely culprit.
      const attachments = summarizeAttachments(fd)
      const res = await fetch(`${API_BASE}/api/application/submit`, {
        method: 'POST',
        body: fd,
        signal: controller.signal,
        headers: applyAccessHeaders(),
      })
      const data = await readJsonSafely(res)
      if (res.ok && data) {
        if (data.status === 'error') {
          // 200 + status:'error' = this mobile number already has an application
          // under review (duplicate phone). It already landed — do NOT offer a
          // retry, or we loop the applicant on a submit that already succeeded.
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
        // Every handled outcome is a 200, so a genuine 5xx is an unhandled
        // exception that commits nothing (the application insert is atomic;
        // Loandisk borrowers are created only at admin approval). Nothing was
        // saved in any non-2xx case — safe to retry.
        // The multer upload gate answers mid-stream, so its 400 body is often
        // truncated and unreadable — buildHttpFailureResult reconstructs a
        // specific, actionable message from the status plus `attachments`.
        setResult(buildHttpFailureResult({ status: res.status, data, attachments }))
      }
    } catch (err) {
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
            <p className="text-muted mb-8">
              Your application has been received. Our team will review it within 2–3 business days.
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

    // Error
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

  // ── Progress bar ──
  const progress = (step / TOTAL_STEPS) * 100

  const stepLabels = [
    'Loan Details',
    'Personal Info',
    'Present Address',
    'Permanent Address',
    'Employment',
    'Spouse',
    'Documents',
    'Review',
  ]

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
          <h1 className="text-2xl sm:text-3xl font-bold text-green">Personal Loan Application</h1>
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
                please re-attach them at the Documents step.
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
          {step === 1 && (
            <Step1
              form={form}
              set={set}
              errors={errors}
              officers={officers}
              soLoading={soLoading}
              soError={soError}
              soRetry={soRetry}
            />
          )}
          {step === 2 && <Step2 form={form} set={set} errors={errors} />}
          {step === 3 && (
            <Step3 form={form} set={set} errors={errors} prefix="present" title="Present Address" />
          )}
          {step === 4 && <Step4 form={form} set={set} errors={errors} />}
          {step === 5 && <Step5 form={form} set={set} errors={errors} />}
          {step === 6 && <Step6 form={form} set={set} errors={errors} />}
          {step === 7 && (
            <Step8 docs={docs} errors={errors} handleFile={handleFile} removeFile={removeFile} />
          )}
          {step === 8 && <Step9 form={form} set={set} docs={docs} errors={errors} />}

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

// ══════════════════════════════════════
// STEPS
// ══════════════════════════════════════

function Step1({ form, set, errors, officers, soLoading, soError, soRetry }) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-green mb-1">Loan Details</h2>
      <p className="text-muted text-sm mb-4">How much do you need and for how long?</p>

      {/* Application Type */}
      <div>
        <label className="block text-sm font-medium text-white mb-2">Application Type</label>
        <div className="flex rounded-xl border border-border overflow-hidden">
          {[
            ['new', 'New Loan'],
            ['renewal', 'Renewal'],
          ].map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => set('application_category', val)}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                form.application_category === val
                  ? 'bg-green text-white'
                  : 'bg-surface-alt text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Renewal note — the selector is UX only. Matching this application to an
          existing client record is done server-side, so the applicant is never
          asked to hunt down their own borrower record. */}
      {form.application_category === 'renewal' && (
        <p className="text-muted text-xs bg-surface-alt border border-border rounded-xl px-4 py-3">
          We'll match this to your existing GR8 record automatically using your mobile number. Just
          fill in the form as usual.
        </p>
      )}

      {/* Sales Officer Selection */}
      <div className="mb-6">
        <label htmlFor="salesOfficerId" className="block text-sm text-muted mb-2">
          Your Sales Officer <span className="text-red-400">*</span>
        </label>
        {soError ? (
          <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-red-400 text-sm flex-1">Unable to load officers, please refresh</p>
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
            value={form.salesOfficerId}
            onChange={e => set('salesOfficerId', e.target.value)}
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

      {/* Amount input */}
      <div>
        <Label required htmlFor="loanAmount">
          Loan Amount
        </Label>
        <p className="text-muted text-xs mb-2">₱10,000 – ₱200,000</p>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-green font-bold text-lg">
            ₱
          </span>
          <input
            id="loanAmount"
            type="text"
            inputMode="numeric"
            value={form.loanAmount.toLocaleString('en-PH')}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9]/g, '')
              const num = parseInt(raw, 10)
              if (raw === '') {
                set('loanAmount', 0)
                return
              }
              if (!isNaN(num)) set('loanAmount', num)
            }}
            onBlur={() => {
              set('loanAmount', Math.min(Math.max(form.loanAmount, 10000), 200000))
            }}
            className="w-full pl-8 pr-3 py-3 rounded-xl bg-surface-alt border border-border text-green text-right text-xl font-bold focus:outline-none focus:border-green/50 focus:ring-1 focus:ring-green/30 transition-colors"
          />
        </div>
      </div>

      {/* Term */}
      <div>
        <Label required>Payment Term</Label>
        <div className="flex gap-3 mt-1">
          {TERMS.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => set('paymentTerm', t)}
              className={`flex-1 py-3 rounded-xl text-sm font-medium border transition-all ${
                form.paymentTerm === t
                  ? 'border-green bg-green/10 text-green'
                  : 'border-border text-muted hover:border-muted/30 hover:text-white'
              }`}
            >
              {t} months
            </button>
          ))}
        </div>
      </div>

      {/* Purpose */}
      <div>
        <Label required htmlFor="purpose">
          Purpose of Loan
        </Label>
        <Select
          id="purpose"
          value={form.purpose}
          onChange={e => set('purpose', e.target.value)}
          options={PURPOSES}
          placeholder="Select purpose"
        />
        <FieldError message={errors.purpose} />
      </div>
    </div>
  )
}

function Step2({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Personal Information</h2>
      <p className="text-muted text-sm mb-4">Tell us about yourself.</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <Label required htmlFor="firstName">
            First Name
          </Label>
          <Input
            id="firstName"
            autoComplete="given-name"
            value={form.firstName}
            onChange={e => set('firstName', e.target.value)}
            placeholder="Juan"
          />
          <FieldError message={errors.firstName} />
        </div>
        <div>
          <Label htmlFor="middleName">Middle Name</Label>
          <Input
            id="middleName"
            autoComplete="additional-name"
            value={form.middleName}
            onChange={e => set('middleName', e.target.value)}
            placeholder="Santos"
          />
        </div>
        <div>
          <Label required htmlFor="lastName">
            Last Name
          </Label>
          <Input
            id="lastName"
            autoComplete="family-name"
            value={form.lastName}
            onChange={e => set('lastName', e.target.value)}
            placeholder="Dela Cruz"
          />
          <FieldError message={errors.lastName} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required htmlFor="dateOfBirth">
            Date of Birth
          </Label>
          <Input
            id="dateOfBirth"
            autoComplete="bday"
            type="date"
            value={form.dateOfBirth}
            onChange={e => set('dateOfBirth', e.target.value)}
          />
          <FieldError message={errors.dateOfBirth} />
        </div>
        <div>
          <Label required htmlFor="civilStatus">
            Civil Status
          </Label>
          <Select
            id="civilStatus"
            value={form.civilStatus}
            onChange={e => set('civilStatus', e.target.value)}
            options={CIVIL_STATUSES}
            placeholder="Select status"
          />
          <FieldError message={errors.civilStatus} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required htmlFor="mobile">
            Mobile Number
          </Label>
          <Input
            id="mobile"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            value={form.mobile}
            onChange={e => set('mobile', e.target.value)}
            placeholder="09XXXXXXXXX"
            maxLength={11}
          />
          <FieldError message={errors.mobile} />
        </div>
        <div>
          <Label required htmlFor="email">
            Email Address
          </Label>
          <Input
            id="email"
            autoComplete="email"
            type="email"
            value={form.email}
            onChange={e => set('email', e.target.value)}
            placeholder="juan@email.com"
          />
          <FieldError message={errors.email} />
        </div>
      </div>

      <div className="max-w-xs">
        <Label htmlFor="tin">TIN (optional)</Label>
        <Input
          id="tin"
          value={form.tin}
          onChange={e => set('tin', e.target.value)}
          placeholder="000-000-000-000"
        />
      </div>
    </div>
  )
}

function Step3({ form, set, errors, prefix, title }) {
  const f = field => `${prefix}${field.charAt(0).toUpperCase() + field.slice(1)}`
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">{title}</h2>
      <p className="text-muted text-sm mb-4">Where do you currently live?</p>

      <div>
        <Label required htmlFor={f('houseStreet')}>
          House No. / Street
        </Label>
        <Input
          id={f('houseStreet')}
          value={form[f('houseStreet')]}
          onChange={e => set(f('houseStreet'), e.target.value)}
          placeholder="123 Rizal St."
        />
        <FieldError message={errors[f('houseStreet')]} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required htmlFor={f('barangay')}>
            Barangay
          </Label>
          <Input
            id={f('barangay')}
            value={form[f('barangay')]}
            onChange={e => set(f('barangay'), e.target.value)}
            placeholder="Brgy. San Pablo"
          />
          <FieldError message={errors[f('barangay')]} />
        </div>
        <div>
          <Label required htmlFor={f('city')}>
            City / Municipality
          </Label>
          <Input
            id={f('city')}
            value={form[f('city')]}
            onChange={e => set(f('city'), e.target.value)}
            placeholder="Malolos"
          />
          <FieldError message={errors[f('city')]} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <Label required htmlFor={f('province')}>
            Province
          </Label>
          <Input
            id={f('province')}
            value={form[f('province')]}
            onChange={e => set(f('province'), e.target.value)}
            placeholder="Bulacan"
          />
          <FieldError message={errors[f('province')]} />
        </div>
        <div>
          <Label required htmlFor={f('zip')}>
            ZIP Code
          </Label>
          <Input
            id={f('zip')}
            inputMode="numeric"
            value={form[f('zip')]}
            onChange={e => set(f('zip'), e.target.value)}
            placeholder="3000"
            maxLength={4}
          />
          <FieldError message={errors[f('zip')]} />
        </div>
        <div>
          <Label required htmlFor={f('lengthOfStay')}>
            Length of Stay
          </Label>
          <Input
            id={f('lengthOfStay')}
            value={form[f('lengthOfStay')]}
            onChange={e => set(f('lengthOfStay'), e.target.value)}
            placeholder="e.g. 5 years"
          />
          <FieldError message={errors[f('lengthOfStay')]} />
        </div>
      </div>
    </div>
  )
}

function Step4({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Permanent Address</h2>

      <label className="flex items-center gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={form.sameAsPresent}
          onChange={e => set('sameAsPresent', e.target.checked)}
          className="w-5 h-5 rounded border-border bg-surface-alt text-green focus:ring-green/30 accent-green"
        />
        <span className="text-white text-sm font-medium group-hover:text-green transition-colors">
          Same as present address
        </span>
      </label>

      {form.sameAsPresent ? (
        <div className="bg-surface-alt/30 border border-border rounded-xl p-5">
          <p className="text-muted text-sm">
            Permanent address will use the same details as your present address.
          </p>
        </div>
      ) : (
        <Step3 form={form} set={set} errors={errors} prefix="permanent" title="Permanent Address" />
      )}
    </div>
  )
}

function Step5({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Employment & Financial Information</h2>
      <p className="text-muted text-sm mb-4">Tell us about your work and income.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required htmlFor="employmentStatus">
            Employment Status
          </Label>
          <Select
            id="employmentStatus"
            value={form.employmentStatus}
            onChange={e => set('employmentStatus', e.target.value)}
            options={EMPLOYMENT_STATUSES}
            placeholder="Select status"
          />
          <FieldError message={errors.employmentStatus} />
        </div>
        <div>
          <Label required htmlFor="employerName">
            Employer / Business Name
          </Label>
          <Input
            id="employerName"
            value={form.employerName}
            onChange={e => set('employerName', e.target.value)}
            placeholder="Company name"
          />
          <FieldError message={errors.employerName} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required htmlFor="monthlyIncome">
            Monthly Income (₱)
          </Label>
          <Input
            id="monthlyIncome"
            inputMode="numeric"
            type="number"
            value={form.monthlyIncome}
            onChange={e => set('monthlyIncome', e.target.value)}
            placeholder="15000"
            min={0}
          />
          <FieldError message={errors.monthlyIncome} />
        </div>
        <div>
          <Label required htmlFor="lengthOfEmployment">
            Length of Employment
          </Label>
          <Input
            id="lengthOfEmployment"
            value={form.lengthOfEmployment}
            onChange={e => set('lengthOfEmployment', e.target.value)}
            placeholder="e.g. 3 years"
          />
          <FieldError message={errors.lengthOfEmployment} />
        </div>
      </div>
    </div>
  )
}

function Step6({ form, set, errors }) {
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Spouse / Co-Borrower Information</h2>
      <p className="text-muted text-sm mb-4">This section is optional.</p>

      <label className="flex items-center gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={form.addSpouse}
          onChange={e => set('addSpouse', e.target.checked)}
          className="w-5 h-5 rounded border-border bg-surface-alt text-green focus:ring-green/30 accent-green"
        />
        <span className="text-white text-sm font-medium group-hover:text-green transition-colors">
          Add spouse / co-borrower information
        </span>
      </label>

      {form.addSpouse && (
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label required htmlFor="spouseFirstName">
                First Name
              </Label>
              <Input
                id="spouseFirstName"
                value={form.spouseFirstName}
                onChange={e => set('spouseFirstName', e.target.value)}
                placeholder="First name"
              />
              <FieldError message={errors.spouseFirstName} />
            </div>
            <div>
              <Label required htmlFor="spouseLastName">
                Last Name
              </Label>
              <Input
                id="spouseLastName"
                value={form.spouseLastName}
                onChange={e => set('spouseLastName', e.target.value)}
                placeholder="Last name"
              />
              <FieldError message={errors.spouseLastName} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label required htmlFor="spouseMobile">
                Mobile Number
              </Label>
              <Input
                id="spouseMobile"
                type="tel"
                inputMode="numeric"
                value={form.spouseMobile}
                onChange={e => set('spouseMobile', e.target.value)}
                placeholder="09XXXXXXXXX"
                maxLength={11}
              />
              <FieldError message={errors.spouseMobile} />
            </div>
            <div>
              <Label htmlFor="spouseEmployer">Employer</Label>
              <Input
                id="spouseEmployer"
                value={form.spouseEmployer}
                onChange={e => set('spouseEmployer', e.target.value)}
                placeholder="Company name"
              />
            </div>
          </div>
          <div className="max-w-xs">
            <Label htmlFor="spouseIncome">Monthly Income (₱)</Label>
            <Input
              id="spouseIncome"
              inputMode="numeric"
              type="number"
              value={form.spouseIncome}
              onChange={e => set('spouseIncome', e.target.value)}
              placeholder="0"
              min={0}
            />
          </div>
        </div>
      )}

      {!form.addSpouse && (
        <div className="bg-surface-alt/30 border border-border rounded-xl p-5">
          <p className="text-muted text-sm">You can skip this step if not applicable.</p>
        </div>
      )}
    </div>
  )
}

function Step8({ docs, errors, handleFile, removeFile }) {
  const fileInputRefs = useRef({})
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Document Upload</h2>
      <p className="text-muted text-sm mb-4">
        Upload clear photos or scanned copies. JPG, PNG, or PDF only. Max {MAX_UPLOAD_MB}MB per
        file.
      </p>

      <div className="space-y-3">
        {ALL_DOCS.map(doc => {
          const isRequired = REQUIRED_DOCS.some(d => d.key === doc.key)
          const file = docs[doc.key]
          return (
            <div
              key={doc.key}
              className="bg-surface-alt/20 border border-border rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-medium">
                  {doc.label}
                  {isRequired && <span className="text-red-400 ml-1">*</span>}
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
                    <span className="text-muted text-xs truncate">{file.name}</span>
                    <button
                      onClick={() => removeFile(doc.key)}
                      className="text-red-400 hover:text-red-300 text-xs shrink-0 ml-1"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <FieldError message={errors[doc.key]} />
                )}
              </div>
              <div className="shrink-0">
                <input
                  ref={el => (fileInputRefs.current[doc.key] = el)}
                  type="file"
                  accept=".jpg,.jpeg,.png,.pdf"
                  onChange={e => {
                    handleFile(doc.key, e.target.files[0])
                    e.target.value = ''
                  }}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRefs.current[doc.key]?.click()}
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
  )
}

function Step9({ form, set, docs, errors }) {
  const sections = [
    {
      title: 'Loan Details',
      items: [
        ['Amount', formatPeso(form.loanAmount)],
        ['Term', `${form.paymentTerm} months`],
        ['Purpose', form.purpose],
      ],
    },
    {
      title: 'Personal Information',
      items: [
        ['Name', [form.firstName, form.middleName, form.lastName].filter(Boolean).join(' ')],
        ['Date of Birth', form.dateOfBirth],
        ['Civil Status', form.civilStatus],
        ['Mobile', form.mobile],
        ['Email', form.email],
        ...(form.tin ? [['TIN', form.tin]] : []),
      ],
    },
    {
      title: 'Present Address',
      items: [
        [
          'Address',
          `${form.presentHouseStreet}, ${form.presentBarangay}, ${form.presentCity}, ${form.presentProvince} ${form.presentZip}`,
        ],
        ['Length of Stay', form.presentLengthOfStay],
      ],
    },
    {
      title: 'Permanent Address',
      items: form.sameAsPresent
        ? [['', 'Same as present address']]
        : [
            [
              'Address',
              `${form.permanentHouseStreet}, ${form.permanentBarangay}, ${form.permanentCity}, ${form.permanentProvince} ${form.permanentZip}`,
            ],
            ['Length of Stay', form.permanentLengthOfStay],
          ],
    },
    {
      title: 'Employment & Financial',
      items: [
        ['Status', form.employmentStatus],
        ['Employer', form.employerName],
        ['Monthly Income', formatPeso(form.monthlyIncome)],
        ['Length', form.lengthOfEmployment],
      ],
    },
    ...(form.addSpouse
      ? [
          {
            title: 'Spouse / Co-Borrower',
            items: [
              ['Name', `${form.spouseFirstName} ${form.spouseLastName}`],
              ['Mobile', form.spouseMobile],
              ...(form.spouseEmployer ? [['Employer', form.spouseEmployer]] : []),
              ...(form.spouseIncome ? [['Income', formatPeso(form.spouseIncome)]] : []),
            ],
          },
        ]
      : []),
    {
      title: 'Documents',
      items: ALL_DOCS.filter(d => docs[d.key]).map(d => [d.label, docs[d.key].name]),
    },
  ]

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold text-green mb-1">Review Your Application</h2>
      <p className="text-muted text-sm mb-4">Please review all information before submitting.</p>

      {sections.map(section => (
        <div key={section.title} className="bg-surface-alt/20 border border-border rounded-xl p-5">
          <h3 className="text-blue text-xs font-semibold uppercase tracking-wider mb-3">
            {section.title}
          </h3>
          <div className="space-y-2">
            {section.items.map(([label, value], i) => (
              <div key={i} className="flex justify-between gap-4 text-sm">
                {label && <span className="text-muted shrink-0">{label}</span>}
                <span className="text-white text-right break-all">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <label className="flex items-start gap-3 cursor-pointer group pt-2">
        <input
          type="checkbox"
          checked={form.confirmAccurate}
          onChange={e => set('confirmAccurate', e.target.checked)}
          className="w-5 h-5 rounded border-border bg-surface-alt text-green focus:ring-green/30 accent-green mt-0.5"
        />
        <span className="text-white text-sm leading-relaxed group-hover:text-green transition-colors">
          I confirm that all information provided is true and accurate to the best of my knowledge.
        </span>
      </label>
      <FieldError message={errors.confirmAccurate} />

      <label className="flex items-start gap-3 cursor-pointer group pt-2">
        <input
          type="checkbox"
          checked={form.agreeTerms || false}
          onChange={e => set('agreeTerms', e.target.checked)}
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
  )
}
