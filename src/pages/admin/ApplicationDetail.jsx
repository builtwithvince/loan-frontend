import { useState, useEffect, useMemo } from 'react'
import { adminFetch, pipelineFetch, useToast } from './AdminDashboard'
import {
  normalizeFinScore,
  computeFinalFromCiTotal,
  getTier,
  getNextTierHint,
  TIER_CONFIG,
} from './scoring'
import CiScoringForm, { CiFormReadOnly } from './CiScoringForm'
import { useAuth } from '../../context/AuthContext'
import { getApplicantName } from '../../lib/applicantName'
import { STAGE_LABELS, STATUS_CHIP, WITHDRAWABLE_STAGES } from '../../constants/pipeline'
import useSalesOfficers from '../../hooks/useSalesOfficers'
import ClientApplicationsPanel, {
  FinscoreReuseNotice,
} from '../../components/ClientApplicationsPanel'
import { getFinscoreReuse, formatScoreProvenance } from '../../lib/clientLinkage'
import {
  calcLoanSummary,
  fmtCurrency,
  defaultSchemeId,
  defaultRate,
  LOCKED_INTEREST_RATE,
  PAYMENT_SCHEMES,
  PAYMENT_SCHEME_LABELS,
  SCHEME_SUFFIX,
} from '../../lib/loanCalculations'

// --- Shared UI components ---

function Section({ title, children, collapsible = false, defaultOpen = true, rightContent }) {
  const [open, setOpen] = useState(defaultOpen)
  // Titles arrive as "Section N — Name"; the number renders as a step badge.
  const m = typeof title === 'string' ? title.match(/^Section (\d+) — (.+)$/) : null
  const step = m?.[1]
  const label = m ? m[2] : title
  const toggle = () => collapsible && setOpen(o => !o)
  return (
    <div className="x-panel x-section">
      <div
        onClick={toggle}
        onKeyDown={e => {
          if (collapsible && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            toggle()
          }
        }}
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? open : undefined}
        className={`x-section-head${collapsible ? ' x-section-head--toggle' : ''}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          {step && <span className="x-step">{step}</span>}
          <h3 className="x-section-title">{label}</h3>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {rightContent}
          {collapsible && (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`x-chevron${open ? ' is-open' : ''}`}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          )}
        </div>
      </div>
      {open && <div className="x-section-body">{children}</div>}
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <span className="x-field-label">{label}</span>
      <span className="text-white text-sm">{value || '—'}</span>
    </div>
  )
}

function FieldCard({ label, value }) {
  return (
    <div className="x-field-card">
      <span className="x-field-label">{label}</span>
      <span className="text-white text-sm break-words">{value || '—'}</span>
    </div>
  )
}

function Badge({ label, colorClass }) {
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${colorClass}`}>
      {label}
    </span>
  )
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  confirmClass,
  onConfirm,
  onCancel,
  loading,
  loadingLabel,
  requiresReason,
  reasonLabel = 'Reason for Declining',
}) {
  const [reason, setReason] = useState('')
  const MIN_REASON = 10
  const reasonValid = reason.trim().length >= MIN_REASON
  const canConfirm = !loading && (!requiresReason || reasonValid)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60" onClick={loading ? undefined : onCancel} />
      <div className="relative bg-surface border border-border rounded-xl p-6 max-w-md w-full">
        <h3 className="text-white font-bold text-lg mb-2">{title}</h3>
        <p className="text-muted text-sm mb-4">{message}</p>
        {requiresReason && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-white mb-2">
              {reasonLabel} <span className="text-red-400">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={4}
              disabled={loading}
              placeholder="Provide a clear reason (min 10 characters)…"
              className="w-full px-3 py-2 bg-surface-alt border border-border rounded-lg text-white text-sm placeholder:text-muted/60 focus:outline-none focus:border-red-500 disabled:opacity-50 resize-none"
            />
            <div className="flex justify-end mt-1">
              <span className={`text-xs ${reasonValid ? 'text-muted' : 'text-amber-400/70'}`}>
                {reason.trim().length}/{MIN_REASON} characters
              </span>
            </div>
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-muted hover:text-white border border-border rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(requiresReason ? reason.trim() : undefined)}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${confirmClass}`}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {loadingLabel || 'Processing…'}
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// Manual override for applications declined due to missing FinScore.
// Approver-level action: sends the application back to the Approver stage for manual review.
function OverrideModal({ fullName, loading, inlineError, onConfirm, onCancel }) {
  const [reason, setReason] = useState('')
  const MIN_REASON = 10
  const reasonValid = reason.trim().length >= MIN_REASON
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60" onClick={loading ? undefined : onCancel} />
      <div className="relative bg-surface border border-border rounded-xl p-6 max-w-md w-full">
        <h3 className="text-white font-bold text-lg mb-2">Manual Override</h3>
        <p className="text-muted text-sm mb-4">
          This application was declined due to missing FinScore. Override to send back to Approver
          stage for manual review?
        </p>
        <div className="mb-4">
          <label className="block text-sm font-medium text-white mb-2">
            Override Reason <span className="text-red-400">*</span>
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
            disabled={loading}
            placeholder="Explain why this application warrants manual review (min 10 characters)…"
            className="w-full px-3 py-2 bg-surface-alt border border-border rounded-lg text-white text-sm placeholder:text-muted/60 focus:outline-none focus:border-blue disabled:opacity-50 resize-none"
          />
          <div className="flex justify-end mt-1">
            <span className={`text-xs ${reasonValid ? 'text-muted' : 'text-amber-400/70'}`}>
              {reason.trim().length}/{MIN_REASON} characters
            </span>
          </div>
        </div>
        {inlineError && (
          <p className="mb-4 text-sm text-red-400 bg-red-500/7 border border-red-500/21 rounded-lg px-3 py-2">
            {inlineError}
          </p>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-muted hover:text-white border border-border rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={loading || !reasonValid}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue hover:bg-blue/80 text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Overriding…
              </span>
            ) : (
              'Override & Send to Approver'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// The stage_history entry written when the application was withdrawn, if any.
function getWithdrawEntry(app) {
  return (app.stage_history || []).findLast(h => h.to === 'withdrawn') || null
}

function formatCurrency(amount) {
  return '₱' + Number(amount || 0).toLocaleString()
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function calcAge(dob) {
  if (!dob) return null
  const birth = new Date(dob)
  if (isNaN(birth)) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
  return age
}

// Helper to get a value from app data, checking both top-level and form_data
function getField(app, ...keys) {
  const fd = app.form_data || {}
  for (const k of keys) {
    if (app[k] != null && app[k] !== '') return app[k]
    if (fd[k] != null && fd[k] !== '') return fd[k]
  }
  return null
}

// --- Section 1: Application Summary ---

function SoAssigner({ app, appId, onAssigned }) {
  const { hasAnyRole } = useAuth()
  const canAssign = hasAnyRole(['admin', 'super_admin'])
  const { officers } = useSalesOfficers()
  const [assigning, setAssigning] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const addToast = useToast()

  const soId = app.assigned_sales_officer
  const soName =
    app.assigned_sales_officer_name ||
    (soId && officers.find(o => o.id === soId)?.full_name) ||
    null

  const handleAssign = async officerId => {
    setAssigning(true)
    try {
      const res = await pipelineFetch(`/${appId}/assign-sales-officer`, {
        method: 'PATCH',
        body: JSON.stringify({ sales_officer_id: officerId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to assign SO')
      }
      addToast('Sales Officer assigned')
      setShowPicker(false)
      await onAssigned()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setAssigning(false)
    }
  }

  if (!canAssign) {
    return soName ? (
      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-teal-500/12 text-teal-400/60">
        SO: {soName}
      </span>
    ) : (
      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-500/20 text-gray-400">
        No SO Assigned
      </span>
    )
  }

  if (showPicker) {
    return (
      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <select
          defaultValue=""
          onChange={e => e.target.value && handleAssign(e.target.value)}
          disabled={assigning}
          className="bg-surface-alt border border-border rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-green/50"
        >
          <option value="" disabled>
            Select SO...
          </option>
          {officers.map(o => (
            <option key={o.id} value={o.id}>
              {o.full_name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowPicker(false)}
          className="text-muted hover:text-white text-xs transition-colors"
        >
          Cancel
        </button>
        {assigning && (
          <div className="w-3.5 h-3.5 border-2 border-green border-t-transparent rounded-full animate-spin" />
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={`px-2.5 py-1 rounded-full text-xs font-medium ${
          soName ? 'bg-teal-500/12 text-teal-400/60' : 'bg-gray-500/20 text-gray-400'
        }`}
      >
        {soName ? `SO: ${soName}` : 'No SO Assigned'}
      </span>
      <button
        onClick={e => {
          e.stopPropagation()
          setShowPicker(true)
        }}
        className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue/12 text-blue/60 hover:bg-blue/18 hover:text-blue transition-colors"
      >
        {soName ? 'Change' : 'Assign'}
      </button>
    </div>
  )
}

function ApplicationSummary({ app, appId, onRefresh }) {
  const fd = app.form_data || {}
  const data = { ...fd, ...app } // app fields override form_data
  const age = calcAge(data.date_of_birth || data.dob || data.birthdate || data.dateOfBirth)
  const loanType = app.loan_type || ''
  const isGroup = loanType === 'group'
  const members = app.members || app.group_members || fd.members || fd.group_members || []
  const fileMetadata = app.file_metadata || fd.file_metadata || app.files || fd.files || []

  // Build address strings
  const presentAddr =
    [
      getField(app, 'presentStreet', 'present_street', 'street'),
      getField(app, 'presentBarangay', 'present_barangay', 'barangay'),
      getField(app, 'presentCity', 'present_city', 'city'),
      getField(app, 'presentProvince', 'present_province', 'province'),
      getField(app, 'presentZip', 'present_zip', 'zip'),
    ]
      .filter(Boolean)
      .join(', ') ||
    getField(app, 'present_address', 'address') ||
    '—'

  const permanentAddr =
    [
      getField(app, 'permanentStreet', 'permanent_street'),
      getField(app, 'permanentBarangay', 'permanent_barangay'),
      getField(app, 'permanentCity', 'permanent_city'),
      getField(app, 'permanentProvince', 'permanent_province'),
      getField(app, 'permanentZip', 'permanent_zip'),
    ]
      .filter(Boolean)
      .join(', ') ||
    getField(app, 'permanent_address') ||
    'Same as present'

  // Personal references
  const refs = []
  for (const suffix of ['A', 'B', 'C', '1', '2', '3']) {
    const name = getField(
      app,
      `reference${suffix}Name`,
      `reference_${suffix.toLowerCase()}_name`,
      `ref${suffix}Name`,
    )
    if (name) {
      refs.push({
        name,
        relationship: getField(
          app,
          `reference${suffix}Relationship`,
          `reference_${suffix.toLowerCase()}_relationship`,
          `ref${suffix}Relationship`,
        ),
        contact: getField(
          app,
          `reference${suffix}Contact`,
          `reference_${suffix.toLowerCase()}_contact`,
          `ref${suffix}Contact`,
          `reference${suffix}Phone`,
        ),
      })
    }
  }

  // Spouse / co-borrower
  const spouseName = getField(
    app,
    'spouseName',
    'spouse_name',
    'spouseFirstName',
    'coBorrowerName',
    'co_borrower_name',
  )

  return (
    <Section
      title="Section 1 — Application Summary"
      rightContent={<SoAssigner app={app} appId={appId} onAssigned={onRefresh} />}
    >
      <div className="pt-4 space-y-5">
        {/* Personal Information */}
        <div>
          <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
            Personal Information
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <FieldCard label="Full Name" value={getApplicantName(app) || null} />
            <FieldCard label="Age" value={age != null ? `${age} years old` : null} />
            <FieldCard
              label="Date of Birth"
              value={getField(app, 'date_of_birth', 'dob', 'birthdate', 'dateOfBirth')}
            />
            <FieldCard label="Civil Status" value={getField(app, 'civil_status', 'civilStatus')} />
            <FieldCard label="Mobile" value={app.mobile || app.phone} />
            <FieldCard label="Email" value={app.email} />
            <FieldCard label="TIN" value={getField(app, 'tin', 'TIN')} />
          </div>
        </div>

        {/* Address */}
        <div>
          <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">Address</p>
          <div className="grid grid-cols-1 gap-2">
            <FieldCard label="Present Address" value={presentAddr} />
            <FieldCard label="Permanent Address" value={permanentAddr} />
          </div>
        </div>

        {/* Employment / Financial */}
        <div>
          <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
            Employment / Financial
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <FieldCard
              label="Employment Status"
              value={getField(app, 'employmentStatus', 'employment_status')}
            />
            <FieldCard
              label="Employer / Business Name"
              value={getField(
                app,
                'employer',
                'employerName',
                'employer_name',
                'businessName',
                'business_name',
                'borrower_business_name',
              )}
            />
            <FieldCard
              label="Monthly Income"
              value={
                getField(app, 'monthlyIncome', 'monthly_income', 'income')
                  ? formatCurrency(getField(app, 'monthlyIncome', 'monthly_income', 'income'))
                  : null
              }
            />
            <FieldCard
              label="Length of Employment"
              value={getField(
                app,
                'lengthOfEmployment',
                'length_of_employment',
                'yearsEmployed',
                'years_employed',
              )}
            />
            <FieldCard
              label="Position"
              value={getField(app, 'position', 'jobTitle', 'job_title')}
            />
          </div>
        </div>

        {/* Spouse / Co-borrower */}
        {spouseName && (
          <div>
            <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
              Spouse / Co-borrower
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <FieldCard label="Name" value={spouseName} />
              <FieldCard
                label="Mobile"
                value={getField(
                  app,
                  'spouseMobile',
                  'spouse_mobile',
                  'coBorrowerMobile',
                  'co_borrower_mobile',
                )}
              />
              <FieldCard
                label="Employer"
                value={getField(
                  app,
                  'spouseEmployer',
                  'spouse_employer',
                  'coBorrowerEmployer',
                  'co_borrower_employer',
                )}
              />
              <FieldCard
                label="Income"
                value={
                  getField(
                    app,
                    'spouseIncome',
                    'spouse_income',
                    'coBorrowerIncome',
                    'co_borrower_income',
                  )
                    ? formatCurrency(
                        getField(
                          app,
                          'spouseIncome',
                          'spouse_income',
                          'coBorrowerIncome',
                          'co_borrower_income',
                        ),
                      )
                    : null
                }
              />
            </div>
          </div>
        )}

        {/* Personal References */}
        {refs.length > 0 && (
          <div>
            <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
              Personal References
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {refs.map((ref, i) => (
                <FieldCard
                  key={i}
                  label={`Reference ${String.fromCharCode(65 + i)}`}
                  value={`${ref.name}${ref.relationship ? ` (${ref.relationship})` : ''}${ref.contact ? ` — ${ref.contact}` : ''}`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Loan Details */}
        <div>
          <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
            Loan Details
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <FieldCard label="Loan Type" value={loanType.toUpperCase()} />
            <FieldCard label="Amount" value={formatCurrency(app.loan_amount || app.amount)} />
            <FieldCard
              label="Term"
              value={
                getField(app, 'term', 'loan_term')
                  ? `${getField(app, 'term', 'loan_term')} months`
                  : null
              }
            />
            <FieldCard
              label="Purpose"
              value={getField(app, 'loan_purpose', 'loanPurpose', 'purpose')}
            />
            <FieldCard
              label="Application Type"
              value={app.application_category === 'renewal' ? 'Renewal' : 'New'}
            />
            {app.application_category === 'renewal' && app.linked_borrower_id && (
              <FieldCard label="Linked Borrower ID" value={app.linked_borrower_id} />
            )}
          </div>
        </div>

        {/* Group members */}
        {isGroup && members.length > 0 && (
          <div>
            <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">
              Group Members ({members.length})
            </p>
            <div className="space-y-2">
              {members.map((member, idx) => (
                <Section
                  key={idx}
                  title={`Member ${idx + 1}: ${getApplicantName(member)}`}
                  collapsible
                  defaultOpen={false}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-4">
                    {Object.entries(member).map(([k, v]) => (
                      <FieldCard
                        key={k}
                        label={k
                          .replace(/([A-Z])/g, ' $1')
                          .replace(/_/g, ' ')
                          .trim()}
                        value={String(v || '—')}
                      />
                    ))}
                  </div>
                </Section>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  )
}

// --- File Viewer Modal ---

function FileViewerModal({ appId, onClose }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const fetchFiles = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await adminFetch(`/applications/${appId}/files`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.message || data.error || 'Failed to load files')
        if (cancelled) return
        const list = Array.isArray(data) ? data : data.files || data.data || []
        setFiles(list)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchFiles()
    return () => {
      cancelled = true
    }
  }, [appId])

  const isImage = (url, name) => {
    const str = (name || url || '').toLowerCase()
    return /\.(jpg|jpeg|png|gif|webp)/.test(str) || /image\//.test(str)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl shadow-black/60"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-white font-bold text-lg">Documents</h2>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-5 h-5"
            >
              <path d="M6 18 18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-green border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-500/7 border border-red-500/21 rounded-lg">
              <p className="text-red-400/70 text-sm">{error}</p>
            </div>
          )}

          {!loading && !error && files.length === 0 && (
            <p className="text-muted text-sm text-center py-8">
              No documents found for this application.
            </p>
          )}

          {!loading && !error && files.length > 0 && (
            <div className="space-y-4">
              {files.map((f, i) => {
                const rawField = f.field || f.fieldName || f.field_name || f.label || ''
                const FIELD_LABELS = {
                  validIdFront: 'Valid ID — Front',
                  validIdBack: 'Valid ID — Back',
                  validId: 'Valid Government ID',
                  barangayClearance: 'Barangay Clearance',
                  payslip: 'Payslip',
                  coe: 'Certificate of Employment (COE)',
                  payslipCoe: 'Payslip + COE',
                  proofOfBilling: 'Proof of Billing',
                  proofOfIncome: 'Proof of Income',
                  businessPermitBarangay: 'Business Permit — Barangay',
                  businessPermit: 'Business Permit',
                  dtiPermit: 'DTI Permit',
                  dtiRegistration: 'DTI Registration',
                  suppliersCustomersList: 'List of 3 Suppliers / Customers',
                  certificateOfNoClaim: 'Certificate of No Claim',
                  sblApplicationForm: 'SBL Application Form',
                  proofOfResidency: 'Proof of Residency',
                  latestItr: 'Latest ITR',
                  bankStatement: 'Bank Statement',
                  prcId: 'PRC ID',
                  companyId: 'Company ID',
                }
                const label =
                  FIELD_LABELS[rawField] ||
                  (rawField.startsWith('member_')
                    ? rawField.replace(/member_(\d+)_file_(\d+)/, 'Member $1 — File $2')
                    : null) ||
                  rawField ||
                  `File ${i + 1}`
                const name = f.filename || f.originalname || f.name || ''
                const url = f.url || f.signed_url || f.signedUrl || ''

                return (
                  <div
                    key={i}
                    className="bg-surface-alt border border-border rounded-lg overflow-hidden"
                  >
                    <div className="px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-muted text-xs">{label}</p>
                        <p className="text-white text-sm">{name || 'Document'}</p>
                      </div>
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue/60 hover:text-blue transition-colors shrink-0 ml-3"
                        >
                          Open in new tab ↗
                        </a>
                      )}
                    </div>
                    {url && isImage(url, name) && (
                      <div className="px-4 pb-4">
                        <img
                          src={url}
                          alt={name || label}
                          className="max-w-full max-h-96 rounded-lg border border-border object-contain mx-auto"
                        />
                      </div>
                    )}
                    {url && !isImage(url, name) && (
                      <div className="px-4 pb-4">
                        <iframe
                          src={url}
                          title={name || label}
                          className="w-full h-96 rounded-lg border border-border bg-white"
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-6 pb-6 pt-2 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Section 2: FinScore Result ---

function FinScoreSection({ app, finscoreRaw, finscoreNorm }) {
  const unavailable = !finscoreRaw || finscoreRaw <= 0
  // On an attributed row finscore_raw/normalized are copied from the source
  // application, so the number is indistinguishable from a fresh measurement.
  // Label it inline at the value — the amber notice below reinforces, but this
  // is what a reader sees first.
  const provenance = formatScoreProvenance(getFinscoreReuse(app))

  return (
    <Section title="Section 2 — FinScore Result">
      <div className="pt-4">
        {/* Renewals may carry a score over instead of pulling a fresh one —
            say so before staff read the number as a new credit check. */}
        <FinscoreReuseNotice app={app} className="mb-4" />
        {unavailable ? (
          <div>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <Field label="Raw Score" value="Not Available" />
              <Field label="Normalized" value="0 / 100" />
            </div>
            <div className="bg-amber-500/7 border border-amber-500/21 rounded-lg p-3 flex items-center gap-2">
              <span className="text-amber-400/70 text-lg">⚠</span>
              <span className="text-amber-400/70 text-sm">
                FinScore unavailable — CI carries full weight on 50pts max
              </span>
            </div>
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
              <Field
                label="Raw Score"
                value={provenance ? `${finscoreRaw} · ${provenance}` : finscoreRaw}
              />
              <Field label="Normalized" value={`${finscoreNorm} / 100`} />
              <Field
                label="Contributes"
                value={`${Math.round(finscoreNorm * 0.5 * 10) / 10} / 50 pts to final`}
              />
            </div>
            <div className="bg-surface-alt rounded-lg p-3">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">FinScore Normalized</span>
                <span className="text-blue/60">{finscoreNorm} / 100</span>
              </div>
              <div className="h-3 bg-canvas rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue rounded-full transition-all duration-300"
                  style={{ width: `${finscoreNorm}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </Section>
  )
}

// --- Section 4: Decision ---

function LoanSummaryPanel({ principal, durationMonths, ratePercent, schemeId, loanType }) {
  const summary = calcLoanSummary(principal, durationMonths, ratePercent, schemeId, loanType)
  const suffix = SCHEME_SUFFIX[schemeId] || '/ month'
  const schemeLabel = PAYMENT_SCHEME_LABELS[schemeId] || '—'
  return (
    <div className="bg-canvas border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border/60">
        <p className="text-muted text-xs font-semibold uppercase tracking-wide">Loan Summary</p>
      </div>
      <div className="px-4 py-3 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted">Principal</span>
          <span className="text-white font-medium">{fmtCurrency(principal)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Service Processing Fee (5%)</span>
          <span className="text-white">{fmtCurrency(summary.serviceFee)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Insurance Charges (1%)</span>
          <span className="text-white">{fmtCurrency(summary.insuranceFee)}</span>
        </div>
        <div className="border-t border-border/50 pt-1.5 flex justify-between">
          <span className="text-muted">Net Disbursement to Borrower</span>
          <span className="text-green font-semibold">{fmtCurrency(summary.netDisbursement)}</span>
        </div>
        <div className="pt-1 flex justify-between">
          <span className="text-muted">Total Interest</span>
          <span className="text-white">{fmtCurrency(summary.totalInterest)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Total Repayment</span>
          <span className="text-white font-medium">{fmtCurrency(summary.totalRepayment)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Number of Repayments</span>
          <span className="text-white">
            {summary.numRepayments} ({schemeLabel})
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Repayment Amount</span>
          <span className="text-blue/80 font-semibold">
            {fmtCurrency(summary.repaymentAmount)} {suffix}
          </span>
        </div>
        {summary.isAkapCapped && (
          <p className="text-amber-400/70 text-xs pt-1">
            AKAP loans are capped at 24 weekly repayments.
          </p>
        )}
      </div>
    </div>
  )
}

function DecisionSection({ app, id, effectiveTier, effectiveFinal, tierConfig, onRefresh }) {
  const loanType = (app.loan_type || '').toLowerCase()
  const originalAmount = app.loan_amount || app.amount || ''
  const originalTerm = app.loan_term || app.term || ''
  const originalInterestRate = app.interest_rate || LOCKED_INTEREST_RATE
  const originalSchemeId = app.payment_scheme_id || defaultSchemeId(loanType)

  const [adjustedAmount, setAdjustedAmount] = useState(String(originalAmount))
  const [adjustedTerm, setAdjustedTerm] = useState(String(originalTerm))
  // Rate is locked at 5%/month for all products — backend clamps to 5..5.
  const interestRate = LOCKED_INTEREST_RATE
  const [schemeId, setSchemeId] = useState(defaultSchemeId(loanType))
  const [loanReleaseDate, setLoanReleaseDate] = useState(app.loan_release_date || '')
  const [fieldErrors, setFieldErrors] = useState({})
  const [actionLoading, setActionLoading] = useState(false)
  const [confirmModal, setConfirmModal] = useState(null)
  const [overrideModal, setOverrideModal] = useState(false)
  const [overrideLoading, setOverrideLoading] = useState(false)
  const [overrideError, setOverrideError] = useState('')
  const addToast = useToast()
  const { hasAnyRole } = useAuth()
  const fullName = getApplicantName(app)
  const isDecided = app.status !== 'pending'
  const isAkap = loanType === 'akap'
  const isWithdrawn = app.status === 'withdrawn'
  const withdrawEntry = isWithdrawn ? getWithdrawEntry(app) : null

  // Loan Release Date — required before approving in the Approver stage (Part 5).
  const isApproverStage = app.stage === 'approver'
  const releaseDateValid = !isApproverStage || !!loanReleaseDate

  // Manual override: only for apps declined due to a missing/zero FinScore, approver-level roles.
  const finscoreRaw = Number(app.finscore_raw || app.finscore || 0)
  const finUnavailable = !finscoreRaw || finscoreRaw <= 0
  const canOverride =
    app.status === 'declined' && finUnavailable && hasAnyRole(['approver', 'admin', 'super_admin'])

  const handleOverride = async overrideReason => {
    if (overrideLoading) return
    setOverrideLoading(true)
    setOverrideError('')
    try {
      const res = await adminFetch(`/applications/${id}/override`, {
        method: 'PATCH',
        body: JSON.stringify({ override_reason: overrideReason }),
      })
      if (res.status === 403) {
        setOverrideError('Override is only available for applications with missing FinScore.')
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to override')
      setOverrideModal(false)
      addToast('Application sent back to Approver for manual review')
      await onRefresh()
    } catch (err) {
      addToast(err.message || 'Failed to override', 'error')
    } finally {
      setOverrideLoading(false)
    }
  }

  const availableSchemes = isAkap
    ? PAYMENT_SCHEMES.filter(s => s.id === 4)
    : PAYMENT_SCHEMES.filter(s => s.id !== 4)

  const hasDiff = () => {
    const amtChanged = adjustedAmount && Number(adjustedAmount) !== Number(originalAmount)
    const termChanged = adjustedTerm && Number(adjustedTerm) !== Number(originalTerm)
    const rateChanged = interestRate !== originalInterestRate
    const schemeChanged = schemeId !== originalSchemeId
    return amtChanged || termChanged || rateChanged || schemeChanged
  }

  const validateFields = () => {
    const e = {}
    if (!adjustedAmount || Number(adjustedAmount) <= 0) e.amount = 'Enter a valid loan amount'
    const term = Number(adjustedTerm)
    if (!term || term < 3 || term > 24) e.term = 'Duration must be between 3 and 24 months'
    return e
  }

  const executeAction = async (endpoint, body = {}) => {
    if (actionLoading) return
    setActionLoading(true)
    const isApprove = endpoint === 'approve'
    let keepLoading = false
    try {
      const res = await adminFetch(`/applications/${id}/${endpoint}`, {
        method: 'PATCH',
        body: JSON.stringify({ reviewed_by: app.reviewed_by || undefined, ...body }),
        // Approve holds the request open through the synchronous Loandisk push,
        // including per-file transfer. A group renewal with ~60 documents is the
        // worst case, so this is generous on purpose: a false abort here is
        // costly, because a retry can silently no-op against the backend's
        // concurrency claim and report success without pushing a loan.
        timeoutMs: isApprove ? 180000 : undefined,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || `Failed to ${endpoint}`)
      if (isApprove) {
        const borrowerId =
          data.borrowerId ||
          data.borrower_id ||
          data.application?.borrower_id ||
          data.application?.loandisk_borrower_id
        addToast(
          borrowerId ? `Application approved · Borrower #${borrowerId}` : 'Application approved',
        )
      } else {
        addToast(`Application ${endpoint}d`)
      }
      await onRefresh()
    } catch (err) {
      if (isApprove && err.name === 'AbortError') {
        keepLoading = true
        addToast('Approval is taking longer than expected. Refreshing status…', 'info')
        setTimeout(async () => {
          try {
            const latest = await onRefresh()
            const bid = latest?.borrower_id || latest?.loandisk_borrower_id
            if (latest?.status === 'approved' && bid) {
              addToast(`Application approved · Borrower #${bid}`)
            } else {
              addToast(
                'Status unchanged. Retrying may create a duplicate borrower — verify in Loandisk before retrying.',
                'error',
              )
            }
          } finally {
            setActionLoading(false)
          }
        }, 5000)
        return
      }
      addToast(err.message || `Failed to ${endpoint}`, 'error')
    } finally {
      if (!keepLoading) setActionLoading(false)
    }
  }

  const confirmAction = (
    title,
    message,
    label,
    cls,
    action,
    loadingLabel,
    requiresReason = false,
  ) => {
    setConfirmModal({
      title,
      message,
      confirmLabel: label,
      confirmClass: cls,
      action,
      loadingLabel,
      requiresReason,
    })
  }

  const executeConfirm = async reason => {
    if (confirmModal?.action) await confirmModal.action(reason)
    setConfirmModal(null)
  }

  const handleApprove = (isOverride = false) => {
    const errs = validateFields()
    if (isApproverStage && !loanReleaseDate) {
      errs.releaseDate = 'Loan Release Date is required before approving.'
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    const approveBody = {
      adjusted_amount: Number(adjustedAmount),
      adjusted_term: Number(adjustedTerm),
      interest_rate: LOCKED_INTEREST_RATE,
      payment_scheme_id: schemeId,
      loan_release_date: loanReleaseDate || null,
    }
    // Override path (declined recommendation): carry the edited terms + override flag.
    // Sends the union of two contracts /approve already accepts: adjusted_* and { override: true }.
    if (isOverride) {
      confirmAction(
        'Override: Approve',
        `Override approval for ${fullName}? This requires supervisor approval.`,
        'Override Approve',
        'bg-gray-500 hover:bg-gray-600 text-white',
        () => executeAction('approve', { ...approveBody, override: true }),
        'Approving… up to a minute',
      )
      return
    }
    if (hasDiff()) {
      const parts = []
      if (Number(adjustedAmount) !== Number(originalAmount))
        parts.push(
          `Amount: ${formatCurrency(Number(originalAmount))} → ${formatCurrency(Number(adjustedAmount))}`,
        )
      if (Number(adjustedTerm) !== Number(originalTerm))
        parts.push(`Term: ${originalTerm} mo → ${adjustedTerm} mo`)
      if (interestRate !== originalInterestRate)
        parts.push(`Rate: ${originalInterestRate}% → ${interestRate}%`)
      if (schemeId !== originalSchemeId)
        parts.push(
          `Scheme: ${PAYMENT_SCHEME_LABELS[originalSchemeId]} → ${PAYMENT_SCHEME_LABELS[schemeId]}`,
        )
      confirmAction(
        'Modified Loan Terms',
        `You've changed the SA's original terms (${parts.join(' | ')}). Approving will send this back to the SA for confirmation.`,
        'Confirm & Send to SA',
        'bg-amber-500 hover:bg-amber-600 text-white',
        () => executeAction('approve', approveBody),
        'Sending to SA…',
      )
    } else {
      confirmAction(
        'Approve Application',
        `Are you sure you want to approve this application for ${fullName}?`,
        'Approve',
        'bg-green hover:bg-green-hover text-white',
        () => executeAction('approve', approveBody),
        'Approving… up to a minute',
      )
    }
  }

  const inputCls =
    'w-full bg-surface-alt border border-border rounded-lg px-4 py-2.5 text-white text-sm focus:border-green/50 focus:ring-1 focus:ring-green/30 outline-none'
  const inputErrCls =
    'w-full bg-surface-alt border border-red-500/50 rounded-lg px-4 py-2.5 text-white text-sm focus:border-red-400/50 focus:ring-1 focus:ring-red-400/20 outline-none'

  const LoanTermsFields = ({ requireAmount = false }) => (
    <div className="space-y-4">
      {/* Amount + Term */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-muted text-xs block mb-1.5">Loan Amount (₱)</label>
          <input
            type="number"
            value={adjustedAmount}
            onChange={e => {
              setAdjustedAmount(e.target.value)
              setFieldErrors(prev => ({ ...prev, amount: undefined }))
            }}
            className={fieldErrors.amount ? inputErrCls : inputCls}
            placeholder={requireAmount ? 'e.g. 20000' : undefined}
          />
          {fieldErrors.amount && <p className="text-red-400 text-xs mt-1">{fieldErrors.amount}</p>}
        </div>
        <div>
          <label className="text-muted text-xs block mb-1.5">Loan Duration (Months)</label>
          <input
            type="number"
            min={3}
            max={24}
            step={1}
            value={adjustedTerm}
            onChange={e => {
              setAdjustedTerm(e.target.value)
              setFieldErrors(prev => ({ ...prev, term: undefined }))
            }}
            className={fieldErrors.term ? inputErrCls : inputCls}
            placeholder={requireAmount ? 'e.g. 6' : undefined}
          />
          <p className="text-muted text-xs mt-1">Between 3 and 24 months.</p>
          {fieldErrors.term && <p className="text-red-400 text-xs mt-0.5">{fieldErrors.term}</p>}
        </div>
      </div>

      {/* Payment Scheme + Interest Rate */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-muted text-xs block mb-1.5">Payment Scheme</label>
          <select
            value={schemeId}
            onChange={e => setSchemeId(Number(e.target.value))}
            disabled={isAkap}
            className={`${inputCls} disabled:opacity-60 disabled:cursor-not-allowed appearance-none`}
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394A3B8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10l-5 5z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 14px center',
            }}
          >
            {availableSchemes.map(s => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-muted text-xs block mb-1.5">Interest Rate</label>
          <div className={`${inputCls} bg-surface cursor-default`}>
            {LOCKED_INTEREST_RATE}% / month
          </div>
          <p className="text-muted text-xs mt-1">
            Fixed at {LOCKED_INTEREST_RATE}% per month for all loan products.
          </p>
        </div>
      </div>

      {/* Loan Release Date — required in Approver stage (Part 5) */}
      {isApproverStage && (
        <div>
          <label className="text-muted text-xs block mb-1.5">
            Loan Release Date <span className="text-red-400">*</span>
          </label>
          <input
            type="date"
            value={loanReleaseDate}
            onChange={e => {
              setLoanReleaseDate(e.target.value)
              setFieldErrors(prev => ({ ...prev, releaseDate: undefined }))
            }}
            className={`${fieldErrors.releaseDate ? inputErrCls : inputCls} [color-scheme:dark]`}
          />
          {fieldErrors.releaseDate && (
            <p className="text-red-400 text-xs mt-1">{fieldErrors.releaseDate}</p>
          )}
        </div>
      )}

      {/* Loan Summary */}
      <LoanSummaryPanel
        principal={Number(adjustedAmount) || 0}
        durationMonths={Number(adjustedTerm) || 0}
        ratePercent={interestRate}
        schemeId={schemeId}
        loanType={loanType}
      />
    </div>
  )

  return (
    <Section title="Section 4 — Decision">
      <div className="pt-4">
        {confirmModal && (
          <ConfirmModal
            title={confirmModal.title}
            message={confirmModal.message}
            confirmLabel={confirmModal.confirmLabel}
            confirmClass={confirmModal.confirmClass}
            loading={actionLoading}
            loadingLabel={confirmModal.loadingLabel}
            requiresReason={confirmModal.requiresReason}
            onConfirm={executeConfirm}
            onCancel={() => setConfirmModal(null)}
          />
        )}

        {overrideModal && (
          <OverrideModal
            fullName={fullName}
            loading={overrideLoading}
            inlineError={overrideError}
            onConfirm={handleOverride}
            onCancel={() => {
              setOverrideModal(false)
              setOverrideError('')
            }}
          />
        )}

        {/* Already decided */}
        {isDecided ? (
          <div className="space-y-4">
            <div
              className={`border rounded-lg p-4 ${
                app.status === 'approved'
                  ? 'bg-green/6 border-green/18'
                  : app.status === 'pending_sa_confirmation'
                    ? 'bg-amber-500/7 border-amber-500/21'
                    : isWithdrawn
                      ? 'bg-surface-alt border-border'
                      : 'bg-red-500/7 border-red-500/21'
              }`}
            >
              <p
                className={`text-lg font-bold ${
                  app.status === 'approved'
                    ? 'text-green/60'
                    : app.status === 'pending_sa_confirmation'
                      ? 'text-amber-400/70'
                      : isWithdrawn
                        ? 'text-muted'
                        : 'text-red-400/70'
                }`}
              >
                {app.status === 'approved'
                  ? 'APPROVED'
                  : app.status === 'pending_sa_confirmation'
                    ? 'PENDING SA CONFIRMATION'
                    : isWithdrawn
                      ? 'WITHDRAWN'
                      : 'DECLINED'}
              </p>
              {withdrawEntry?.meta?.withdraw_reason && (
                <p className="text-muted text-sm mt-1">{withdrawEntry.meta.withdraw_reason}</p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field
                label="Final Score"
                value={effectiveFinal != null ? `${effectiveFinal} / 100` : '—'}
              />
              <Field
                label="Tier"
                value={<Badge label={tierConfig.label} colorClass={tierConfig.badgeClass} />}
              />
              <Field
                label="Status"
                value={
                  <Badge
                    label={
                      app.status === 'pending_sa_confirmation'
                        ? 'Pending SA Confirmation'
                        : app.status
                    }
                    colorClass={
                      app.status === 'approved'
                        ? 'bg-green/12 text-green/60'
                        : app.status === 'pending_sa_confirmation'
                          ? 'bg-amber-500/14 text-amber-400/70'
                          : isWithdrawn
                            ? 'bg-surface-alt text-muted'
                            : 'bg-red-500/14 text-red-400/70'
                    }
                  />
                }
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {app.reviewed_by && <Field label="Reviewed By" value={app.reviewed_by} />}
              {app.reviewed_at && <Field label="Reviewed At" value={formatDate(app.reviewed_at)} />}
              {app.borrower_id && <Field label="Loandisk Borrower ID" value={app.borrower_id} />}
              {app.status === 'pending_sa_confirmation' && app.approver_proposed_amount && (
                <Field
                  label="Proposed Amount"
                  value={formatCurrency(app.approver_proposed_amount)}
                />
              )}
              {app.status === 'pending_sa_confirmation' && app.approver_proposed_term && (
                <Field label="Proposed Term" value={`${app.approver_proposed_term} months`} />
              )}
            </div>

            {/* Manual override — declined due to missing FinScore (approver-level) */}
            {canOverride && (
              <div className="flex flex-col items-start gap-1 pt-2 border-t border-border/50">
                <button
                  onClick={() => {
                    setOverrideError('')
                    setOverrideModal(true)
                  }}
                  className="bg-blue hover:bg-blue/80 text-white font-medium text-sm px-6 py-2.5 rounded-lg transition-colors"
                >
                  Override
                </button>
                <span className="text-xs text-muted">
                  Declined due to missing FinScore — send back to Approver for manual review.
                </span>
              </div>
            )}
          </div>
        ) : (
          <div>
            {/* Recommendation banner */}
            <div className={`border rounded-lg p-4 mb-5 ${tierConfig.bgClass}`}>
              <p className={`text-sm font-medium ${tierConfig.textClass}`}>
                {tierConfig.recommendation}
              </p>
            </div>

            {/* Tier-specific actions */}
            {effectiveTier === 'approved' && (
              <div className="space-y-5">
                {/* Original values */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-surface-alt/50 rounded-lg">
                  <div>
                    <p className="text-muted text-xs mb-0.5">SA Original Amount</p>
                    <p className="text-white text-sm font-medium">
                      {formatCurrency(originalAmount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted text-xs mb-0.5">SA Original Term</p>
                    <p className="text-white text-sm font-medium">
                      {originalTerm ? `${originalTerm} months` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted text-xs mb-0.5">Original Rate</p>
                    <p className="text-white text-sm font-medium">{originalInterestRate}%</p>
                  </div>
                  <div>
                    <p className="text-muted text-xs mb-0.5">Original Scheme</p>
                    <p className="text-white text-sm font-medium">
                      {PAYMENT_SCHEME_LABELS[originalSchemeId] || '—'}
                    </p>
                  </div>
                </div>

                <LoanTermsFields />

                {hasDiff() && (
                  <div className="flex items-start gap-2 p-3 bg-amber-500/7 border border-amber-500/21 rounded-lg">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
                    >
                      <path
                        d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <p className="text-amber-400/70 text-xs">
                      Terms differ from SA's original. Approving will send back to SA for
                      confirmation before proceeding to Loandisk.
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => handleApprove()}
                    disabled={actionLoading || !releaseDateValid}
                    className={`font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      hasDiff()
                        ? 'bg-amber-500 hover:bg-amber-600 text-white'
                        : 'bg-green hover:bg-green-hover text-white'
                    }`}
                  >
                    {actionLoading ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Processing…
                      </span>
                    ) : hasDiff() ? (
                      'Approve with Modified Terms'
                    ) : (
                      'Approve'
                    )}
                  </button>
                  <button
                    onClick={() =>
                      confirmAction(
                        'Decline Application',
                        `Are you sure you want to decline this application for ${fullName}?`,
                        'Decline',
                        'bg-red-500 hover:bg-red-600 text-white',
                        reason => executeAction('decline', { decline_reason: reason }),
                        undefined,
                        true,
                      )
                    }
                    disabled={actionLoading}
                    className="border border-red-500 text-red-400 hover:bg-red-500/10 font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}

            {effectiveTier === 'tier_b' && (
              <div className="space-y-5">
                <LoanTermsFields requireAmount />
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => handleApprove()}
                    disabled={actionLoading || !releaseDateValid}
                    className="bg-amber-500 hover:bg-amber-600 text-white font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Processing…
                      </span>
                    ) : (
                      'Approve with Adjustments'
                    )}
                  </button>
                  <button
                    onClick={() =>
                      confirmAction(
                        'Decline Application',
                        `Are you sure you want to decline this application for ${fullName}?`,
                        'Decline',
                        'bg-red-500 hover:bg-red-600 text-white',
                        reason => executeAction('decline', { decline_reason: reason }),
                        undefined,
                        true,
                      )
                    }
                    disabled={actionLoading}
                    className="border border-red-500 text-red-400 hover:bg-red-500/10 font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}

            {effectiveTier === 'declined' && (
              <div className="space-y-5">
                {/* Editable terms — always available regardless of FinScore */}
                <LoanTermsFields requireAmount />
                <div className="flex flex-wrap gap-3 items-start">
                  <button
                    onClick={() =>
                      confirmAction(
                        'Decline Application',
                        `Are you sure you want to decline this application for ${fullName}?`,
                        'Decline',
                        'bg-red-500 hover:bg-red-600 text-white',
                        reason => executeAction('decline', { decline_reason: reason }),
                        undefined,
                        true,
                      )
                    }
                    disabled={actionLoading}
                    className="bg-red-500 hover:bg-red-600 text-white font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Decline
                  </button>
                  <div className="flex flex-col items-start gap-1">
                    <button
                      onClick={() => handleApprove(true)}
                      disabled={actionLoading || !releaseDateValid}
                      className="border border-gray-500 text-gray-400 hover:bg-gray-500/10 font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Override Approve
                    </button>
                    <span className="text-xs text-amber-400/70">
                      Override requires supervisor approval
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <WithdrawAction app={app} id={id} onRefresh={onRefresh} />
      </div>
    </Section>
  )
}

// Withdraw: the applicant dropped out. A neutral close, not a decline (decision 022).
// Mirrors the backend guard: same roles as decline, pre-approval stages, nothing pushed to
// Loandisk. Rendered with and without a CI score, since most drop-outs never reach CI.
function WithdrawAction({ app, id, onRefresh }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const addToast = useToast()
  const { hasAnyRole } = useAuth()

  const canWithdraw =
    ['pending', 'pending_sa_confirmation'].includes(app.status) &&
    WITHDRAWABLE_STAGES.includes(app.stage) &&
    !app.loandisk_loan_id &&
    !app.loan_push_claimed_at &&
    hasAnyRole(['approver', 'admin', 'super_admin'])
  if (!canWithdraw) return null

  const handleWithdraw = async reason => {
    if (loading) return
    setLoading(true)
    try {
      const res = await pipelineFetch(`/${id}/transition`, {
        method: 'PATCH',
        body: JSON.stringify({ to_stage: 'withdrawn', meta: { withdraw_reason: reason } }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to withdraw')
      setModalOpen(false)
      addToast('Application withdrawn')
      await onRefresh()
    } catch (err) {
      addToast(err.message || 'Failed to withdraw', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-6 pt-4 border-t border-border flex flex-wrap items-center gap-3">
      {modalOpen && (
        <ConfirmModal
          title="Withdraw Application"
          message={`Withdraw the application for ${getApplicantName(app)}? Use this when the applicant dropped out. It is not a decline: their mobile number is freed and a new application will not be flagged.`}
          confirmLabel="Withdraw"
          confirmClass="bg-gray-500 hover:bg-gray-600 text-white"
          loading={loading}
          loadingLabel="Withdrawing…"
          requiresReason
          reasonLabel="Reason for Withdrawing"
          onConfirm={handleWithdraw}
          onCancel={() => setModalOpen(false)}
        />
      )}
      <button
        onClick={() => setModalOpen(true)}
        disabled={loading}
        className="border border-border text-muted hover:text-white hover:bg-surface-alt font-medium text-sm px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50"
      >
        Withdraw
      </button>
      <span className="text-xs text-muted">
        Applicant dropped out. Closes the application without a decline.
      </span>
    </div>
  )
}

// --- SA Confirmation Banner ---

function SaConfirmationBanner({ app, id, onRefresh }) {
  const [rejectMode, setRejectMode] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [loading, setLoading] = useState(false)
  const addToast = useToast()

  const originalAmount = app.loan_amount || app.amount
  const originalTerm = app.loan_term || app.term
  const originalRate = app.interest_rate || defaultRate(app.loan_type || '')
  const originalScheme = app.payment_scheme_id || defaultSchemeId(app.loan_type || '')
  const proposedAmount = app.approver_proposed_amount
  const proposedTerm = app.approver_proposed_term
  const proposedRate = app.approver_proposed_interest_rate
  const proposedScheme = app.approver_proposed_payment_scheme_id

  const amountDiff = proposedAmount && Number(proposedAmount) !== Number(originalAmount)
  const termDiff = proposedTerm && Number(proposedTerm) !== Number(originalTerm)
  const rateDiff = proposedRate != null && Number(proposedRate) !== Number(originalRate)
  const schemeDiff = proposedScheme != null && Number(proposedScheme) !== Number(originalScheme)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      const res = await adminFetch(`/applications/${id}/confirm-terms`, { method: 'PATCH' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to confirm')
      addToast('Terms confirmed — returned to Approver for final approval')
      await onRefresh()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleReject = async () => {
    if (!rejectNote.trim()) return
    setLoading(true)
    try {
      const res = await adminFetch(`/applications/${id}/reject-terms`, {
        method: 'PATCH',
        body: JSON.stringify({ note: rejectNote.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to reject')
      addToast('Changes rejected — application returned to approver')
      await onRefresh()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-amber-500/7 border border-amber-500/30 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-amber-500/20 flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-4 h-4 text-amber-400 shrink-0"
        >
          <path
            d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <h3 className="text-amber-400 font-semibold text-sm">
          Approver Modified Loan Terms — SA Confirmation Required
        </h3>
      </div>

      <div className="px-5 pb-5 pt-4 space-y-4">
        {/* Diff table */}
        <div className="overflow-hidden rounded-lg border border-amber-500/20">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-amber-500/20">
                <th className="text-left px-3 py-2 text-muted text-xs font-medium w-24">Field</th>
                <th className="text-left px-3 py-2 text-muted text-xs font-medium">
                  Original (SA)
                </th>
                <th className="text-left px-3 py-2 text-amber-400/70 text-xs font-medium">
                  Proposed (Approver)
                </th>
              </tr>
            </thead>
            <tbody>
              {amountDiff && (
                <tr className="border-b border-amber-500/10 last:border-0">
                  <td className="px-3 py-2 text-muted text-xs">Amount</td>
                  <td className="px-3 py-2 text-white">{formatCurrency(originalAmount)}</td>
                  <td className="px-3 py-2 text-amber-400 font-medium">
                    {formatCurrency(proposedAmount)}
                  </td>
                </tr>
              )}
              {termDiff && (
                <tr className="border-b border-amber-500/10 last:border-0">
                  <td className="px-3 py-2 text-muted text-xs">Term</td>
                  <td className="px-3 py-2 text-white">{originalTerm} months</td>
                  <td className="px-3 py-2 text-amber-400 font-medium">{proposedTerm} months</td>
                </tr>
              )}
              {rateDiff && (
                <tr className="border-b border-amber-500/10 last:border-0">
                  <td className="px-3 py-2 text-muted text-xs">Rate</td>
                  <td className="px-3 py-2 text-white">{originalRate}%</td>
                  <td className="px-3 py-2 text-amber-400 font-medium">{proposedRate}%</td>
                </tr>
              )}
              {schemeDiff && (
                <tr className="border-b border-amber-500/10 last:border-0">
                  <td className="px-3 py-2 text-muted text-xs">Scheme</td>
                  <td className="px-3 py-2 text-white">
                    {PAYMENT_SCHEME_LABELS[originalScheme] || '—'}
                  </td>
                  <td className="px-3 py-2 text-amber-400 font-medium">
                    {PAYMENT_SCHEME_LABELS[proposedScheme] || '—'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {app.discount_reason && (
          <div className="p-3 bg-canvas border border-amber-500/20 rounded-lg">
            <p className="text-muted text-xs mb-0.5">Discount reason from approver:</p>
            <p className="text-white text-sm">{app.discount_reason}</p>
          </div>
        )}

        {rejectMode ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-muted mb-1.5">
                Reason for rejection <span className="text-red-400">*</span>
              </label>
              <textarea
                value={rejectNote}
                onChange={e => setRejectNote(e.target.value)}
                rows={3}
                placeholder="Explain why you're rejecting the approver's modified terms..."
                className="w-full bg-canvas border border-border rounded-lg px-3 py-2 text-sm text-white placeholder-muted/50 focus:border-red-400/50 focus:ring-1 focus:ring-red-400/20 outline-none resize-none transition-colors"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleReject}
                disabled={loading || !rejectNote.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Rejecting…
                  </span>
                ) : (
                  'Confirm Rejection'
                )}
              </button>
              <button
                onClick={() => {
                  setRejectMode(false)
                  setRejectNote('')
                }}
                disabled={loading}
                className="px-4 py-2 text-sm text-muted hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-green hover:bg-green-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Confirming…
                </span>
              ) : (
                'Confirm Changes'
              )}
            </button>
            <button
              onClick={() => setRejectMode(true)}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-red-500/50 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              Reject Changes
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Activity Log ---

function ActivityLog({ app, finscoreRaw, finscoreNorm, effectiveFinal, effectiveTier }) {
  return (
    <Section title="Activity Log">
      <div className="pt-5">
        <ol>
          {(app.submitted_at || app.created_at) && (
            <LogEntry
              color="bg-blue/60"
              text="Application received"
              date={formatDate(app.submitted_at || app.created_at)}
            />
          )}
          {finscoreRaw > 0 && (
            <LogEntry
              color="bg-blue/60"
              text={`FinScore calculated: ${finscoreRaw} (normalized: ${finscoreNorm})`}
            />
          )}
          {app.ci_score != null && (
            <LogEntry
              color="bg-green/60"
              text={`CI submitted: ${app.ci_score}/50${app.reviewed_by ? ` by ${app.reviewed_by}` : ''}`}
              date={app.reviewed_at ? formatDate(app.reviewed_at) : null}
              note={app.notes || app.ci_notes}
            />
          )}
          {app.ci_score != null && effectiveFinal != null && (
            <LogEntry
              color={
                effectiveTier === 'approved'
                  ? 'bg-green/60'
                  : effectiveTier === 'tier_b'
                    ? 'bg-amber-500/70'
                    : 'bg-red-500/70'
              }
              text={`Final Score: ${effectiveFinal} → Tier: ${TIER_CONFIG[effectiveTier]?.label || effectiveTier}`}
            />
          )}
          {(app.stage_history || [])
            .filter(h => h.type === 'sa_confirmation' || h.type === 'sa_rejection')
            .map((h, i) => {
              const date = h.at || h.timestamp || h.created_at
              if (h.type === 'sa_confirmation') {
                const amt = h.meta?.confirmed_amount
                const term = h.meta?.confirmed_term
                const terms = [amt ? formatCurrency(amt) : null, term ? `${term} months` : null]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <LogEntry
                    key={`sh-${i}`}
                    color="bg-amber-500/70"
                    text={`SA confirmed adjusted terms${terms ? `: ${terms}` : ''} — returned to Approver for final approval`}
                    date={date ? formatDate(date) : null}
                  />
                )
              }
              return (
                <LogEntry
                  key={`sh-${i}`}
                  color="bg-red-500/70"
                  text="SA rejected adjusted terms — returned to Approver"
                  date={date ? formatDate(date) : null}
                  note={h.note || h.meta?.note}
                />
              )
            })}
          {app.status === 'withdrawn'
            ? (() => {
                const w = getWithdrawEntry(app)
                return (
                  <LogEntry
                    color="bg-gray-500/70"
                    text={`Application withdrawn${w?.by_name ? ` by ${w.by_name}` : ''}`}
                    date={w?.at ? formatDate(w.at) : null}
                    note={w?.meta?.withdraw_reason}
                  />
                )
              })()
            : app.status !== 'pending' && (
                <LogEntry
                  color={app.status === 'approved' ? 'bg-green/60' : 'bg-red-500/70'}
                  text={`Application ${app.status}${app.reviewed_by ? ` by ${app.reviewed_by}` : ''}`}
                  date={app.reviewed_at ? formatDate(app.reviewed_at) : null}
                />
              )}
        </ol>
      </div>
    </Section>
  )
}

function LogEntry({ color, text, date, note }) {
  return (
    <li className="x-log-item">
      <span className={`x-log-dot ${color}`} aria-hidden="true" />
      <p className="text-white text-sm leading-snug">{text}</p>
      {date && <p className="text-muted text-xs mt-0.5">{date}</p>}
      {note && <p className="text-muted text-xs mt-1">Notes: {note}</p>}
    </li>
  )
}

// --- Detail hero: who, what, and where it stands ---

function DetailHero({
  app,
  finscoreRaw,
  finscoreNorm,
  effectiveFinal,
  effectiveTier,
  onViewDocuments,
}) {
  const status = STATUS_CHIP[app.status] || { label: app.status, tone: 'x-chip--neutral' }
  const amount = app.loan_amount || app.amount
  const term = app.loan_term || app.term
  const hasFinal = app.ci_score != null && effectiveFinal != null
  const kicker = [
    app.reference_id,
    app.loan_type,
    app.application_category === 'renewal' ? 'Renewal' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <header className="x-hero">
      <div className="x-hero-top">
        <div className="min-w-0">
          <p className="x-kicker">{kicker}</p>
          <h1 className="x-hero-name">{getApplicantName(app) || '—'}</h1>
          <div className="x-hero-chips">
            <span className={`x-chip ${status.tone}`}>{status.label}</span>
            {app.stage && STAGE_LABELS[app.stage] && (
              <span className="x-chip x-chip--info">Stage: {STAGE_LABELS[app.stage]}</span>
            )}
            {hasFinal && effectiveTier && (
              <span
                className={`x-chip ${TIER_CONFIG[effectiveTier]?.chipClass || 'x-chip--neutral'}`}
              >
                {TIER_CONFIG[effectiveTier]?.label || effectiveTier}
              </span>
            )}
            {app.prior_decline_flag && <span className="x-chip x-chip--warn">Prior Decline</span>}
            {app.assigned_sales_officer_name && (
              <span className="x-chip x-chip--neutral">SO: {app.assigned_sales_officer_name}</span>
            )}
          </div>
        </div>
        <button onClick={onViewDocuments} className="x-pill x-pill--on-deep">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path
              d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          View Documents
        </button>
      </div>

      <dl className="x-hero-metrics">
        <div className="x-metric">
          <dt className="x-metric-label">Amount</dt>
          <dd className="x-metric-value">{amount ? formatCurrency(amount) : '—'}</dd>
        </div>
        <div className="x-metric">
          <dt className="x-metric-label">Term</dt>
          <dd className="x-metric-value">{term ? `${term} mo` : '—'}</dd>
        </div>
        <div className="x-metric">
          <dt className="x-metric-label">FinScore</dt>
          <dd className="x-metric-value">{finscoreRaw > 0 ? finscoreNorm : '—'}</dd>
          <dd className="x-metric-sub">
            {finscoreRaw > 0 ? `of 100 · raw ${finscoreRaw}` : 'Not available'}
          </dd>
        </div>
        <div className="x-metric">
          <dt className="x-metric-label">Final score</dt>
          <dd className="x-metric-value">{hasFinal ? effectiveFinal : '—'}</dd>
          <dd className="x-metric-sub">
            {hasFinal ? `CI ${app.ci_score} / 50` : 'Awaiting CI assessment'}
          </dd>
        </div>
      </dl>
    </header>
  )
}

// --- Main Component ---

export default function ApplicationDetail({ id, onBack }) {
  const [app, setApp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showFileViewer, setShowFileViewer] = useState(false)
  const addToast = useToast()
  const { hasRole, hasAnyRole } = useAuth()
  const isCiRole = hasRole('ci_officer')
  // CI scoring is editable only by CI Officer, Approver, and Super Admin (Part 7).
  const canScoreCi = hasAnyRole(['ci_officer', 'approver', 'super_admin'])

  const fetchApp = async () => {
    try {
      setLoading(true)
      const [adminRes, pipelineRes] = await Promise.all([
        adminFetch(`/applications/${id}`),
        pipelineFetch(`/${id}`).catch(() => null),
      ])
      if (!adminRes.ok) throw new Error('Failed to fetch application')
      const adminData = await adminRes.json()
      const appData = adminData.application || adminData

      // Merge SO fields from pipeline endpoint if admin endpoint doesn't have them
      if (pipelineRes?.ok) {
        const pipelineData = await pipelineRes.json().catch(() => ({}))
        const pd = pipelineData.application || pipelineData
        if (!appData.assigned_sales_officer_name && pd.assigned_sales_officer_name) {
          appData.assigned_sales_officer_name = pd.assigned_sales_officer_name
        }
        if (!appData.assigned_sales_officer && pd.assigned_sales_officer) {
          appData.assigned_sales_officer = pd.assigned_sales_officer
        }
      }

      setApp(appData)
      setError(null)
      return appData
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchApp()
  }, [id])

  const finscoreRaw = app ? Number(app.finscore_raw || app.finscore || 0) : 0
  const finscoreNorm = useMemo(() => normalizeFinScore(finscoreRaw), [finscoreRaw])

  const storedFinal =
    app?.ci_score != null ? computeFinalFromCiTotal(finscoreNorm, app.ci_score) : null
  const storedTier = storedFinal != null ? getTier(storedFinal) : null
  const effectiveTier = app?.tier || storedTier
  const effectiveFinal = app?.final_score != null ? app.final_score : storedFinal
  const tierConfig = TIER_CONFIG[effectiveTier] || TIER_CONFIG.declined

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-green border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 mb-4">{error}</p>
        <button onClick={fetchApp} className="text-green hover:text-green-hover text-sm">
          Retry
        </button>
      </div>
    )
  }

  if (!app) return null

  const isPending = app.status === 'pending'
  const hasCiScore = app.ci_score != null
  const showCiForm = isPending && !hasCiScore

  return (
    <div>
      <button onClick={onBack} className="x-pill mb-5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        Back to Applications
      </button>

      <DetailHero
        app={app}
        finscoreRaw={finscoreRaw}
        finscoreNorm={finscoreNorm}
        effectiveFinal={effectiveFinal}
        effectiveTier={effectiveTier}
        onViewDocuments={() => setShowFileViewer(true)}
      />

      <div className="x-detail-grid">
        <div className="x-detail-main">
          {/* SECTION 1 — Application Summary */}
          <ApplicationSummary app={app} appId={id} onRefresh={fetchApp} />

          {/* SECTION 2 — FinScore Result */}
          <FinScoreSection app={app} finscoreRaw={finscoreRaw} finscoreNorm={finscoreNorm} />

          {/* SECTION 3 — CI Assessment Form (editable only by CI Officer / Approver / Super Admin) */}
          {showCiForm &&
            (canScoreCi ? (
              <Section title="Section 3 — CI Assessment Form" collapsible defaultOpen={isCiRole}>
                <div className="pt-4">
                  <CiScoringForm
                    app={app}
                    appId={id}
                    finscoreRaw={finscoreRaw}
                    finscoreNorm={finscoreNorm}
                    onSubmitSuccess={fetchApp}
                  />
                </div>
              </Section>
            ) : (
              <Section title="Section 3 — CI Assessment Form">
                <div className="pt-4">
                  <div className="bg-surface-alt rounded-lg p-6 text-center">
                    <p className="text-muted text-sm">Awaiting CI Assessment</p>
                    <p className="text-muted/60 text-xs mt-1">
                      Only the CI Officer, Approver, or Super Admin can complete this form.
                    </p>
                  </div>
                </div>
              </Section>
            ))}

          {/* CI Form Read-Only (after submission) */}
          {hasCiScore && (app.ci_form_data || app.ci_form) && (
            <Section title="Section 3 — CI Assessment (Submitted)" collapsible defaultOpen={false}>
              <div className="pt-4">
                <CiFormReadOnly ciFormData={app.ci_form_data || app.ci_form} />
              </div>
            </Section>
          )}

          {/* SO Confirmation section — only in approver stage */}
          {app.stage === 'approver' && (
            <Section title="Sales Officer Confirmation" collapsible defaultOpen>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
                {app.so_confirmation_sent_at && (
                  <FieldCard
                    label="Confirmation Sent"
                    value={formatDate(app.so_confirmation_sent_at)}
                  />
                )}
                {app.so_decision && (
                  <>
                    <FieldCard
                      label="SO Decision"
                      value={app.so_decision === 'confirm' ? 'Confirmed' : 'Declined'}
                    />
                    {app.so_decision_at && (
                      <FieldCard label="Decision Date" value={formatDate(app.so_decision_at)} />
                    )}
                  </>
                )}
                {!app.so_confirmation_sent_at && (
                  <div className="col-span-full">
                    <p className="text-muted text-sm">No confirmation request sent yet.</p>
                  </div>
                )}
                {app.so_confirmation_sent_at && !app.so_decision && (
                  <div className="col-span-full">
                    <span className="text-yellow-400/70 text-sm animate-pulse">
                      Awaiting sales officer response…
                    </span>
                  </div>
                )}
                {app.returned_count > 0 && (
                  <FieldCard label="Times Returned" value={String(app.returned_count)} />
                )}
              </div>
            </Section>
          )}

          {/* SA rejection note — shown to approver when SA sent terms back */}
          {app.sa_rejection_note && app.status === 'pending' && app.stage === 'approver' && (
            <div className="bg-red-500/7 border border-red-500/30 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-red-500/20 flex items-center gap-2">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="w-4 h-4 text-red-400 shrink-0"
                >
                  <path
                    d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <h3 className="text-red-400 font-semibold text-sm">
                  SA Rejected Modified Terms — Re-review Required
                </h3>
              </div>
              <div className="px-5 py-4">
                <p className="text-muted text-xs mb-1">Rejection reason from Sales Officer:</p>
                <p className="text-white text-sm">{app.sa_rejection_note}</p>
                {app.sa_rejection_at && (
                  <p className="text-muted text-xs mt-2">{formatDate(app.sa_rejection_at)}</p>
                )}
              </div>
            </div>
          )}

          {/* SA Confirmation Banner — shown to SA when approver has modified terms */}
          {app.status === 'pending_sa_confirmation' && (
            <SaConfirmationBanner app={app} id={id} onRefresh={fetchApp} />
          )}

          {/* SECTION 4 — Decision */}
          {hasCiScore ? (
            <DecisionSection
              // Remount when official terms/status change (e.g. confirm-terms adopts the
              // proposed amount/term) so the adjusted-terms inputs re-seed from fresh values.
              key={`${app.status}-${app.loan_amount || app.amount}-${app.loan_term || app.term}`}
              app={app}
              id={id}
              effectiveTier={effectiveTier}
              effectiveFinal={effectiveFinal}
              tierConfig={tierConfig}
              onRefresh={fetchApp}
            />
          ) : (
            <Section title="Section 4 — Decision">
              <div className="pt-4">
                {app.status === 'withdrawn' ? (
                  <div className="bg-surface-alt rounded-lg p-6 text-center">
                    <p className="text-muted text-sm font-bold">WITHDRAWN</p>
                    {getWithdrawEntry(app)?.meta?.withdraw_reason && (
                      <p className="text-muted/60 text-xs mt-1">
                        {getWithdrawEntry(app).meta.withdraw_reason}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="bg-surface-alt rounded-lg p-6 text-center">
                    <p className="text-muted text-sm">Awaiting CI Assessment</p>
                    <p className="text-muted/60 text-xs mt-1">
                      Complete the CI form above to unlock the decision panel
                    </p>
                  </div>
                )}
                <WithdrawAction app={app} id={id} onRefresh={fetchApp} />
              </div>
            </Section>
          )}
        </div>

        {/* Side column (sticky on wide screens): timeline + borrower record */}
        <aside className="x-detail-aside">
          <ActivityLog
            app={app}
            finscoreRaw={finscoreRaw}
            finscoreNorm={finscoreNorm}
            effectiveFinal={effectiveFinal}
            effectiveTier={effectiveTier}
          />

          {/* Borrower record — name + every application tied to the same Loandisk borrower */}
          <ClientApplicationsPanel app={app} fetcher={adminFetch} />
        </aside>
      </div>

      {/* File Viewer Modal — fetches fresh signed URLs each time */}
      {showFileViewer && <FileViewerModal appId={id} onClose={() => setShowFileViewer(false)} />}
    </div>
  )
}
